import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { normalizeProductionStatus } from './workflow.js';
import { syncOrderToSheets } from './sheets.sync.js';
import {
  applyWarehouseOrderTransitionSideEffectsTx as applyWarehouseOrderTransitionSideEffectsTxV2,
  consumeCanonicalWarehouseReservationsForOrder as consumeCanonicalWarehouseReservationsForOrderV2,
} from '../warehouse/warehouse-order-orchestration.service.js';

// Async fire-and-forget helper — never throws, never blocks the main flow
function fireSheetSync(orgId: string, orderId: string) {
  syncOrderToSheets(orgId, orderId).then(result => {
    if (!result.ok) console.warn('[sheets.sync] non-blocking error:', result.error);
  }).catch(err => {
    console.error('[sheets.sync] unexpected error:', err);
  });
}

type CreateOrderInput = {
  clientId?: string;
  clientName: string;
  clientPhone: string;
  clientPhoneForeign?: string;
  priority: string;
  urgency?: string;
  isDemandingClient?: boolean;
  items: Array<{
    productName: string;
    fabric?: string;
    color?: string;
    gender?: string;
    length?: string;
    size: string;
    quantity: number;
    unitPrice: number;
    notes?: string;
    workshopNotes?: string;
  }>;
  dueDate?: string;
  prepayment?: number;
  paymentMethod?: string;
  paymentBreakdown?: Record<string, number>;
  streetAddress?: string;
  city?: string;
  postalCode?: string;
  deliveryType?: string;
  source?: string;
  expectedPaymentMethod?: string;
  orderDate?: string;
  orderDiscount?: number;
  deliveryFee?: number;
  bankCommissionPercent?: number;
  bankCommissionAmount?: number;
  managerNote?: string;
  sourceRequestId?: string;
};

type OrderRecord = Prisma.ChapanOrderGetPayload<{
  include: {
    items: true;
    productionTasks: true;
    payments: true;
    transfer: true;
    activities: true;
    invoiceOrders: {
      include: {
        invoice: {
          select: {
            id: true;
            invoiceNumber: true;
            status: true;
            seamstressConfirmed: true;
            warehouseConfirmed: true;
          };
        };
      };
    };
  };
}>;

type FulfillmentMode = 'unassigned' | 'warehouse' | 'production';

type RouteOrderItemsInput = Array<{
  itemId: string;
  fulfillmentMode: FulfillmentMode;
}>;

// Helpers

const CLIENT_NAME_WORD_START_RE = /(^|[\s-]+)([a-zа-яёәіңғүұқөһ])/giu;

function normalizeClientName(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(CLIENT_NAME_WORD_START_RE, (_match, separator: string, letter: string) => (
      `${separator}${letter.toLocaleUpperCase('ru-RU')}`
    ));
}

function readKazakhPhoneDigits(value: string) {
  const digits = value.replace(/\D/g, '');

  if (!digits) return '';
  if (digits === '7') return '7';
  if (digits.startsWith('8')) return `7${digits.slice(1)}`.slice(0, 11);
  if (digits.length === 11 && digits.startsWith('7')) return digits.slice(0, 11);
  if (digits.length <= 10) return `7${digits}`.slice(0, 11);

  return `7${digits.slice(-10)}`.slice(0, 11);
}

function formatKazakhPhone(value: string) {
  const digits = readKazakhPhoneDigits(value);
  if (digits.length !== 11 || !digits.startsWith('7')) {
    return value.trim();
  }

  const national = digits.slice(1);
  return `+7 (${national.slice(0, 3)})-${national.slice(3, 6)}-${national.slice(6, 8)}-${national.slice(8, 10)}`;
}

function normalizeWarehouseName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildWarehouseVariantKey(productName: string, attributes: Record<string, string>) {
  const base = normalizeWarehouseName(productName);
  const parts = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${normalizeWarehouseName(value)}`);
  return [base, ...parts].join('|');
}

async function buildOrderItemVariantSnapshot(
  tx: Prisma.TransactionClient,
  orgId: string,
  item: {
    productName: string;
    fabric?: string | null;
    color?: string | null;
    gender?: string | null;
    length?: string | null;
    size: string;
  },
) {
  const normalizedName = normalizeWarehouseName(item.productName);
  const product = await tx.warehouseProductCatalog.findFirst({
    where: { orgId, normalizedName },
    include: {
      fieldLinks: {
        include: { definition: true },
      },
    },
  });

  const rawAttributes = Object.fromEntries(
    Object.entries({
      fabric: item.fabric?.trim() || '',
      color: item.color?.trim() || '',
      gender: item.gender?.trim() || '',
      length: item.length?.trim() || '',
      size: item.size?.trim() || '',
    }).filter(([, value]) => value),
  );

  const availabilityFields = new Set(
    product?.fieldLinks
      .filter((link) => link.definition.affectsAvailability)
      .map((link) => link.definition.code) ?? [],
  );

  const attributesForKey =
    availabilityFields.size > 0
      ? Object.fromEntries(Object.entries(rawAttributes).filter(([key]) => availabilityFields.has(key)))
      : rawAttributes;

  const attributesSummary = Object.entries(rawAttributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');

  return {
    variantKey: buildWarehouseVariantKey(product?.name ?? item.productName, attributesForKey),
    attributesJson: Object.keys(rawAttributes).length > 0 ? rawAttributes : undefined,
    attributesSummary: attributesSummary || undefined,
  };
}

function buildCanonicalReservationActivityContent(summary: {
  mode: 'canonical' | 'skipped' | 'simple';
  reason?: string;
  reservedCount: number;
  replayedCount: number;
  failedCount: number;
  skippedCount: number;
  items: Array<{ itemId: string; status: string; reason?: string }>;
}) {
  const details = summary.items
    .filter((item) => item.status === 'failed' || item.status === 'skipped')
    .slice(0, 3)
    .map((item) => `${item.itemId}: ${item.reason ?? item.status}`)
    .join('; ');

  if (summary.mode === 'skipped') {
    return `Canonical резерв склада пропущен: ${summary.reason ?? 'unknown_reason'}.`;
  }

  return `Canonical резерв склада: создано ${summary.reservedCount}, повторно использовано ${summary.replayedCount}, пропущено ${summary.skippedCount}, ошибок ${summary.failedCount}${details ? `. Детали: ${details}` : ''}`;
}

function hasWarehouseFulfillmentItems(items: Array<{ fulfillmentMode: string }>) {
  return items.some((item) => item.fulfillmentMode === 'warehouse');
}

export async function consumeCanonicalWarehouseReservationsForOrder(
  orgId: string,
  orderId: string,
  authorId: string,
  authorName: string,
) {
  return consumeCanonicalWarehouseReservationsForOrderV2(orgId, orderId, authorId, authorName);
}

export async function applyWarehouseOrderTransitionSideEffectsTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  input: Parameters<typeof applyWarehouseOrderTransitionSideEffectsTxV2>[2],
) {
  return applyWarehouseOrderTransitionSideEffectsTxV2(tx, orgId, input);
}

// Atomic counter increment via raw SQL so concurrent requests never collide.
// Must be called inside a Prisma interactive transaction (tx).
async function nextOrderNumber(orgId: string, tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ order_counter: number; order_prefix: string }>>`
    UPDATE chapan_profiles
    SET    order_counter = order_counter + 1
    WHERE  org_id = ${orgId}
    RETURNING order_counter, order_prefix
  `;
  const row = rows[0];
  if (!row) throw new Error(`Chapan profile not found for org ${orgId}`);
  const { order_counter, order_prefix } = row;
  const prefix = (order_prefix ?? 'ЧП').trim().slice(0, 6).toUpperCase();
  return `${prefix}-${String(order_counter).padStart(3, '0')}`;
}

function computePaymentStatus(paidAmount: number, totalAmount: number): string {
  if (paidAmount >= totalAmount) return 'paid';
  if (paidAmount > 0) return 'partial';
  return 'not_paid';
}

function getOrderStatusLabel(status: string) {
  if (status === 'new') return 'Новый';
  if (status === 'confirmed') return 'Подтверждён';
  if (status === 'in_production') return 'В производстве';
  if (status === 'ready') return 'Готово';
  if (status === 'transferred') return 'Передан';
  if (status === 'on_warehouse') return 'На складе';
  if (status === 'shipped') return 'Отправлен';
  if (status === 'completed') return 'Завершён';
  if (status === 'cancelled') return 'Отменён';
  return status;
}

function formatPaymentMethod(method: string) {
  if (method === 'cash') return 'Наличные';
  if (method === 'card') return 'Карта';
  if (method === 'kaspi_qr') return 'Kaspi QR';
  if (method === 'kaspi_terminal') return 'Kaspi терминал';
  if (method === 'transfer') return 'Перевод';
  if (method === 'mixed') return 'Смешанная оплата';
  return method;
}

function normalizePaymentBreakdown(breakdown: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!breakdown) return undefined;
  const filtered: Record<string, number> = {};
  for (const [key, val] of Object.entries(breakdown)) {
    const amount = Number(val);
    if (Number.isFinite(amount) && amount > 0) {
      filtered[key] = amount;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function buildMixedPaymentNote(breakdown: Record<string, number>) {
  const parts = Object.entries(breakdown)
    .filter(([, amount]) => amount > 0)
    .map(([method, amount]) => `${formatPaymentMethod(method)}: ${amount.toLocaleString('ru-RU')} ₸`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function buildInitialPaymentNote(data: CreateOrderInput) {
  if (data.paymentMethod !== 'mixed' || !data.paymentBreakdown) {
    return undefined;
  }
  return buildMixedPaymentNote(data.paymentBreakdown);
}

function normalizeFulfillmentMode(value: string | null | undefined): FulfillmentMode {
  if (value === 'warehouse' || value === 'production') {
    return value;
  }
  return 'unassigned';
}

function inferFulfillmentMode(params: {
  rawMode: string | null | undefined;
  orderStatus: string;
  hasProductionTask: boolean;
}): FulfillmentMode {
  const normalized = normalizeFulfillmentMode(params.rawMode);

  if (normalized !== 'unassigned') {
    return normalized;
  }

  if (params.hasProductionTask) {
    return 'production';
  }

  if (['ready', 'on_warehouse', 'shipped', 'completed'].includes(params.orderStatus)) {
    return 'warehouse';
  }

  return 'unassigned';
}

function mapOrder(order: OrderRecord) {
  const productionItemIds = new Set(order.productionTasks.map((task) => task.orderItemId));

  return {
    ...order,
    items: order.items.map((item) => ({
      ...item,
      fulfillmentMode: inferFulfillmentMode({
        rawMode: item.fulfillmentMode,
        orderStatus: order.status,
        hasProductionTask: productionItemIds.has(item.id),
      }),
    })),
    productionTasks: order.productionTasks.map((task) => ({
      ...task,
      status: normalizeProductionStatus(task.status),
    })),
    payments: order.payments.map((payment) => ({
      ...payment,
      note: payment.notes ?? null,
      createdAt: payment.paidAt,
      authorName: '',
    })),
    transfer: order.transfer
      ? {
          ...order.transfer,
          status: order.transfer.transferredAt ? 'transferred' : 'pending_confirmation',
          managerConfirmed: order.transfer.confirmedByManager,
          clientConfirmed: order.transfer.confirmedByClient,
          createdAt: order.transfer.transferredAt,
        }
      : null,
  };
}

async function resolveOrderClient(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: Pick<CreateOrderInput, 'clientId' | 'clientName' | 'clientPhone' | 'clientPhoneForeign'>,
) {
  const clientId = data.clientId?.trim();
  const clientName = normalizeClientName(data.clientName);
  const rawKzPhone = data.clientPhone?.trim() ?? '';
  const clientPhone = rawKzPhone ? formatKazakhPhone(rawKzPhone) : '';
  const clientPhoneForeign = data.clientPhoneForeign?.trim() || undefined;

  if (!clientName) {
    throw new ValidationError('Укажите имя клиента');
  }
  if (!clientPhone && !clientPhoneForeign) {
    throw new ValidationError('Укажите телефон клиента');
  }

  // For client lookup use KZ phone if available, otherwise the foreign phone
  const lookupPhone = clientPhone || clientPhoneForeign!;

  if (clientId) {
    const client = await tx.chapanClient.findFirst({
      where: { id: clientId, orgId },
    });

    if (!client) {
      throw new ValidationError('Выбранный клиент не найден в текущей организации');
    }

    return {
      clientId: client.id,
      clientName,
      clientPhone,
      clientPhoneForeign,
    };
  }

  const existingClient = await tx.chapanClient.findFirst({
    where: { orgId, phone: lookupPhone },
    orderBy: { createdAt: 'desc' },
  });

  if (existingClient) {
    return {
      clientId: existingClient.id,
      clientName,
      clientPhone,
      clientPhoneForeign,
    };
  }

  const createdClient = await tx.chapanClient.create({
    data: {
      orgId,
      fullName: clientName,
      phone: lookupPhone,
    },
  });

  return {
    clientId: createdClient.id,
    clientName,
    clientPhone,
    clientPhoneForeign,
  };
}

// List orders

export async function list(orgId: string, filters?: {
  status?: string;
  statuses?: string[];
  priority?: string;
  paymentStatus?: string;
  search?: string;
  sortBy?: string;
  archived?: boolean;
  hasWarehouseItems?: boolean;
}) {
  const where: Record<string, unknown> = { orgId, deletedAt: null };

  if (filters?.archived === true) {
    where.isArchived = true;
  } else {
    where.isArchived = false;
  }

  if (filters?.hasWarehouseItems) {
    // Orders where some items are already at warehouse but the order is still in production
    where.status = { in: ['confirmed', 'in_production'] };
    where.items = { some: { fulfillmentMode: 'warehouse' } };
  } else if (filters?.statuses && filters.statuses.length > 0) {
    where.status = { in: filters.statuses };
  } else if (filters?.status && filters.status !== 'all') {
    where.status = filters.status;
  }
  if (filters?.priority && filters.priority !== 'all') {
    where.priority = filters.priority;
  }
  if (filters?.paymentStatus && filters.paymentStatus !== 'all') {
    where.paymentStatus = filters.paymentStatus;
  }
  if (filters?.search) {
    const q = filters.search.trim();
    where.OR = [
      { orderNumber: { contains: q, mode: 'insensitive' } },
      { clientName: { contains: q, mode: 'insensitive' } },
      { items: { some: { productName: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  const orderBy: Record<string, string> = {};
  switch (filters?.sortBy) {
    case 'dueDate': orderBy.dueDate = 'asc'; break;
    case 'totalAmount': orderBy.totalAmount = 'desc'; break;
    case 'updatedAt': orderBy.updatedAt = 'desc'; break;
    default: orderBy.createdAt = 'desc';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orders = await prisma.chapanOrder.findMany({
    where: where as any,
    orderBy,
    include: {
      items: true,
      productionTasks: true,
      payments: true,
      transfer: true,
      activities: { orderBy: { createdAt: 'desc' } },
      invoiceOrders: {
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              seamstressConfirmed: true,
              warehouseConfirmed: true,
            },
          },
        },
      },
    },
  });

  return orders.map(mapOrder);
}

// Get single order

export async function getById(orgId: string, id: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: true,
      productionTasks: true,
      payments: true,
      transfer: true,
      activities: { orderBy: { createdAt: 'desc' } },
      attachments: { orderBy: { createdAt: 'desc' } },
      invoiceOrders: {
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              seamstressConfirmed: true,
              warehouseConfirmed: true,
              rejectionReason: true,
              createdAt: true,
            },
          },
        },
      },
    },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  return mapOrder(order);
}

export async function setRequiresInvoice(
  orgId: string,
  id: string,
  requiresInvoice: boolean,
) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  await prisma.chapanOrder.update({ where: { id }, data: { requiresInvoice } });
  return { ok: true };
}

export async function returnToReady(
  orgId: string,
  id: string,
  authorId: string,
  authorName: string,
  reason: string,
) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.status !== 'on_warehouse') {
    throw new ValidationError('Заказ не находится на складе');
  }
  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({ where: { id }, data: { status: 'ready' } });
    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'status_change',
        content: `На складе → Готово (возврат от склада): ${reason}`,
        authorId,
        authorName,
      },
    });
  });

  // P3: Release simple warehouse reservations on return-to-ready
  try {
    const { releaseOrderReservations } = await import('../warehouse/warehouse.service.js');
    await releaseOrderReservations(orgId, id);
  } catch { /* non-fatal */ }

  return { ok: true };
}

// Create order

export async function create(orgId: string, authorId: string, authorName: string, data: CreateOrderInput) {
  const totalAmount = data.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const prepayment = Math.max(0, data.prepayment ?? 0);
  const paymentMethod = data.paymentMethod?.trim() || 'cash';
  const paymentNote = buildInitialPaymentNote(data);

  return prisma.$transaction(async (tx) => {
    // Order number is incremented atomically inside the transaction so that
    // a rollback also rolls back the counter — no skipped numbers, no races.
    const orderNumber = await nextOrderNumber(orgId, tx);
    const client = await resolveOrderClient(tx, orgId, data);
    const activityEntries: Prisma.ChapanActivityCreateWithoutOrderInput[] = [
      {
        type: 'system',
        content: 'Заказ создан',
        authorId,
        authorName,
      },
    ];

    if (prepayment > 0) {
      activityEntries.push({
        type: 'payment',
        content: `Предоплата ${prepayment.toLocaleString('ru-RU')} ₸ (${formatPaymentMethod(paymentMethod)})`,
        authorId,
        authorName,
      });
    }

    if (data.managerNote?.trim()) {
      activityEntries.push({
        type: 'comment',
        content: data.managerNote.trim(),
        authorId,
        authorName,
      });
    }

    const orderItemCreates = await Promise.all(
      data.items.map(async (item) => {
        const variantSnapshot = await buildOrderItemVariantSnapshot(tx, orgId, item);
        return {
          productName: item.productName,
          fabric: item.fabric?.trim() || '',
          color: item.color?.trim() || undefined,
          gender: item.gender?.trim() || undefined,
          length: item.length?.trim() || undefined,
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          fulfillmentMode: 'unassigned' as const,
          notes: item.notes,
          workshopNotes: item.workshopNotes,
          ...variantSnapshot,
        };
      }),
    );

    const order = await tx.chapanOrder.create({
      data: {
        orgId,
        orderNumber,
        clientId: client.clientId,
        clientName: client.clientName,
        clientPhone: client.clientPhone,
        clientPhoneForeign: client.clientPhoneForeign ?? null,
        priority: data.priority,
        urgency: data.urgency ?? (data.priority === 'urgent' ? 'urgent' : 'normal'),
        isDemandingClient: data.isDemandingClient ?? (data.priority === 'vip'),
        totalAmount,
        paidAmount: prepayment,
        paymentStatus: computePaymentStatus(prepayment, totalAmount),
        streetAddress: data.streetAddress?.trim() || undefined,
        city: data.city?.trim() || undefined,
        postalCode: data.postalCode?.trim() || undefined,
        deliveryType: data.deliveryType?.trim() || undefined,
        source: data.source?.trim() || undefined,
        expectedPaymentMethod: data.expectedPaymentMethod?.trim() || undefined,
        internalNote: data.managerNote?.trim() || undefined,
        orderDate: data.orderDate ? new Date(data.orderDate) : undefined,
        orderDiscount: data.orderDiscount ?? 0,
        deliveryFee: data.deliveryFee ?? 0,
        bankCommissionPercent: data.bankCommissionPercent ?? 0,
        bankCommissionAmount: data.bankCommissionAmount ?? 0,
        paymentBreakdown: data.paymentMethod === 'mixed'
          ? (normalizePaymentBreakdown(data.paymentBreakdown) ?? undefined)
          : undefined,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        managerId: authorId,
        managerName: authorName,
        items: {
          create: orderItemCreates,
        },
        payments: prepayment > 0 ? {
          create: {
            amount: prepayment,
            method: paymentMethod,
            notes: paymentNote,
          },
        } : undefined,
        activities: {
          create: activityEntries,
        },
      },
      include: {
        items: true,
        productionTasks: true,
        payments: true,
        transfer: true,
        activities: true,
        invoiceOrders: {
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                status: true,
                seamstressConfirmed: true,
                warehouseConfirmed: true,
              },
            },
          },
        },
      },
    });

    if (data.sourceRequestId) {
      await tx.chapanRequest.updateMany({
        where: { id: data.sourceRequestId, orgId },
        data: { status: 'converted', createdOrderId: order.id },
      });
    }

    const mapped = mapOrder(order);
    // Sprint 10: async sync to Google Sheets — fire-and-forget, never blocks
    fireSheetSync(orgId, order.id);
    return mapped;
  });
}

// Confirm order (creates production tasks)

async function applyItemRouting(
  orgId: string,
  id: string,
  authorId: string,
  authorName: string,
  items: RouteOrderItemsInput,
) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: true,
      productionTasks: true,
    },
  });

  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.status !== 'new') {
    throw new ValidationError('Маршрутизацию позиций можно задать только для нового заказа');
  }

  const requestedModes = new Map<string, FulfillmentMode>();
  for (const entry of items) {
    requestedModes.set(entry.itemId, normalizeFulfillmentMode(entry.fulfillmentMode));
  }

  if (requestedModes.size !== order.items.length) {
    throw new ValidationError('Нужно выбрать маршрут для каждой позиции заказа');
  }

  for (const item of order.items) {
    if (!requestedModes.has(item.id)) {
      throw new ValidationError('Нужно выбрать маршрут для каждой позиции заказа');
    }
  }

  const warehouseItems = order.items.filter((item) => requestedModes.get(item.id) === 'warehouse');
  const productionItems = order.items.filter((item) => requestedModes.get(item.id) === 'production');

  if (warehouseItems.length === 0 && productionItems.length === 0) {
    throw new ValidationError('Выберите хотя бы одну позицию для склада или производства');
  }

  const nextStatus = productionItems.length > 0 ? 'confirmed' : 'ready';

  await prisma.$transaction(async (tx) => {
    for (const item of order.items) {
      const fulfillmentMode = requestedModes.get(item.id)!;

      await tx.chapanOrderItem.update({
        where: { id: item.id },
        data: { fulfillmentMode },
      });

      if (fulfillmentMode === 'production') {
        await tx.chapanProductionTask.upsert({
          where: { orderItemId: item.id },
          create: {
            orderId: id,
            orderItemId: item.id,
            productName: item.productName,
            fabric: item.fabric ?? '',
            size: item.size,
            quantity: item.quantity,
            status: 'queued',
          },
          update: {
            productName: item.productName,
            fabric: item.fabric ?? '',
            size: item.size,
            quantity: item.quantity,
            status: 'queued',
            assignedTo: null,
            startedAt: null,
            completedAt: null,
            isBlocked: false,
            blockReason: null,
          },
        });
      } else {
        await tx.chapanProductionTask.deleteMany({
          where: { orderItemId: item.id },
        });
      }
    }

    await tx.chapanOrder.update({
      where: { id },
      data: { status: nextStatus },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'status_change',
        content: `${getOrderStatusLabel(order.status)} → ${getOrderStatusLabel(nextStatus)}`,
        authorId,
        authorName,
      },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'system',
        content: `Маршрут позиций: на склад ${warehouseItems.length}, в производство ${productionItems.length}.`,
        authorId,
        authorName,
      },
    });
  });

  if (productionItems.length > 0) {
    try {
      const { checkOrderBOM } = await import('../warehouse/warehouse.service.js');
      await checkOrderBOM(orgId, id, true);
    } catch {
      // Warehouse BOM setup is optional here.
    }
  }

  if (warehouseItems.length > 0) {
    try {
      const { reserveOrderWarehouseItems } = await import('../warehouse/warehouse.service.js');
      const summary = await reserveOrderWarehouseItems(orgId, id, authorName || 'system');

      await prisma.chapanActivity.create({
        data: {
          orderId: id,
          type: 'system',
          content: buildCanonicalReservationActivityContent(summary),
          authorId,
          authorName,
        },
      });
    } catch {
      await prisma.chapanActivity.create({
        data: {
          orderId: id,
          type: 'system',
          content: 'Canonical резерв склада не выполнен из-за ошибки интеграции.',
          authorId,
          authorName,
        },
      });
    }
  }

  return getById(orgId, id);
}
export async function confirm(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);

  return applyItemRouting(
    orgId,
    id,
    authorId,
    authorName,
    order.items.map((item) => ({ itemId: item.id, fulfillmentMode: 'production' })),
  );
}

export async function routeItems(
  orgId: string,
  id: string,
  authorId: string,
  authorName: string,
  items: RouteOrderItemsInput,
) {
  return applyItemRouting(orgId, id, authorId, authorName, items);
}

// Fulfill from stock (skip production)

export async function fulfillFromStock(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);

  return applyItemRouting(
    orgId,
    id,
    authorId,
    authorName,
    order.items.map((item) => ({ itemId: item.id, fulfillmentMode: 'warehouse' })),
  );
}

// Update order status

// Sprint 10: status change triggers Sheets sync
export async function updateStatus(orgId: string, id: string, status: string, authorId: string, authorName: string, cancelReason?: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: {
        select: {
          fulfillmentMode: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.isArchived) throw new ValidationError('Сначала восстановите заказ из архива');

  if (status === 'ready') {
    const tasks = await prisma.chapanProductionTask.findMany({
      where: { orderId: id },
      select: { status: true },
    });
    if (tasks.length > 0 && !tasks.every((t) => t.status === 'done')) {
      throw new ValidationError('Нельзя перевести заказ в статус «Готово», пока не завершены все производственные задачи');
    }
  }

  // P3 guard: если накладная обязательна, нельзя принять на склад без подтверждённой накладной
  if (status === 'on_warehouse' && order.requiresInvoice) {
    const confirmedInvoice = await prisma.chapanInvoice.findFirst({
      where: { orgId, status: 'confirmed', items: { some: { orderId: id } } },
      select: { id: true },
    });
    if (!confirmedInvoice) {
      throw new ValidationError('Для этого заказа обязательна накладная. Сначала создайте и подтвердите накладную с обеих сторон.');
    }
  }

  if (status === 'shipped' && order.paymentStatus !== 'paid') {
    const balance = order.totalAmount - order.paidAmount;

    await prisma.chapanActivity.create({
      data: {
        orderId: id,
        type: 'system',
        content: `⚠ Попытка отправить неоплаченный заказ (остаток: ${balance.toLocaleString('ru-KZ')} ₸).`,
        authorId,
        authorName,
      },
    });

    throw new ValidationError('Нельзя отправить заказ с неоплаченным остатком.');
  }

  const now = new Date();
  const shouldConsumeWarehouseStock =
    hasWarehouseFulfillmentItems(order.items) && (status === 'shipped' || status === 'completed');
  const shouldPostHandoffDocument = status === 'on_warehouse';
  const shouldPostShipmentDocument =
    hasWarehouseFulfillmentItems(order.items) && (status === 'shipped' || status === 'completed');

  await prisma.$transaction(async (tx) => {
    const operationDocument =
      shouldPostHandoffDocument
        ? {
            documentType: 'handoff_to_warehouse' as const,
            idempotencyKey: `handoff:${id}`,
            payload: {
              trigger: 'order_status_change',
              fromStatus: order.status,
              toStatus: status,
            },
          }
        : shouldPostShipmentDocument
          ? {
              documentType: 'shipment' as const,
              idempotencyKey: `shipment:${id}`,
              payload: {
                trigger: 'order_status_change',
                fromStatus: order.status,
                toStatus: status,
              },
            }
          : undefined;

    await applyWarehouseOrderTransitionSideEffectsTxV2(tx, orgId, {
      orderId: id,
      fromStatus: order.status,
      toStatus: status,
      hasWarehouseItems: hasWarehouseFulfillmentItems(order.items),
      authorId,
      authorName,
      consumeReservations: shouldConsumeWarehouseStock,
      releaseReservations: status === 'cancelled',
      operationDocument,
    });

    await tx.chapanOrder.update({
      where: { id },
      data: {
        status,
        completedAt: status === 'completed' ? now : null,
        cancelledAt: status === 'cancelled' ? now : null,
        cancelReason: status === 'cancelled' ? cancelReason : null,
      },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'status_change',
        content: `${getOrderStatusLabel(order.status)} → ${getOrderStatusLabel(status)}`,
        authorId,
        authorName,
      },
    });
  });

  // P3: Release simple warehouse reservations on cancellation
  if (status === 'cancelled') {
    try {
      const { releaseOrderReservations } = await import('../warehouse/warehouse.service.js');
      await releaseOrderReservations(orgId, id);
    } catch { /* non-fatal */ }
  }

  fireSheetSync(orgId, id);
}

// Add payment

// Sprint 10: payment also triggers Sheets sync
export async function addPayment(orgId: string, orderId: string, authorId: string, authorName: string, data: {
  amount: number;
  method: string;
  notes?: string;
}) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  const newPaidAmount = order.paidAmount + data.amount;
  const newPaymentStatus = computePaymentStatus(newPaidAmount, order.totalAmount);

  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.chapanPayment.create({
      data: {
        orderId,
        amount: data.amount,
        method: data.method,
        notes: data.notes,
      },
    });
    await tx.chapanOrder.update({
      where: { id: orderId },
      data: {
        paidAmount: newPaidAmount,
        paymentStatus: newPaymentStatus,
      },
    });
    await tx.chapanActivity.create({
      data: {
        orderId,
        type: 'payment',
        content: `Оплата ${data.amount.toLocaleString('ru-RU')} ₸ (${formatPaymentMethod(data.method)})`,
        authorId,
        authorName,
      },
    });
    if (newPaymentStatus === 'paid') {
      await tx.chapanUnpaidAlert.updateMany({
        where: { orderId, resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedBy: authorId },
      });
    }
    return created;
  });

  fireSheetSync(orgId, orderId);

  return {
    ...payment,
    note: payment.notes ?? null,
    createdAt: payment.paidAt,
    authorName,
  };
}

// Transfer

export async function initiateTransfer(orgId: string, orderId: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  return prisma.chapanTransfer.create({
    data: { orderId },
  });
}

export async function confirmTransfer(orgId: string, orderId: string, by: 'manager' | 'client', authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: { transfer: true },
  });
  if (!order?.transfer) throw new NotFoundError('ChapanTransfer');

  const updateData: Record<string, unknown> = {};
  if (by === 'manager') updateData.confirmedByManager = true;
  if (by === 'client') updateData.confirmedByClient = true;

  const updated = await prisma.chapanTransfer.update({
    where: { id: order.transfer.id },
    data: updateData,
  });

  // Both confirmed -> mark as transferred
  const bothConfirmed =
    (by === 'manager' ? true : order.transfer.confirmedByManager) &&
    (by === 'client' ? true : order.transfer.confirmedByClient);

  if (bothConfirmed) {
    await prisma.$transaction([
      prisma.chapanTransfer.update({
        where: { id: order.transfer.id },
        data: { transferredAt: new Date() },
      }),
      prisma.chapanOrder.update({
        where: { id: orderId },
        data: { status: 'transferred' },
      }),
      prisma.chapanActivity.create({
        data: {
          orderId,
          type: 'transfer',
          content: 'Передача подтверждена',
          authorId,
          authorName,
        },
      }),
    ]);
  }

  return updated;
}

// Update order

type UpdateOrderInput = {
  clientName?: string;
  clientPhone?: string;
  clientPhoneForeign?: string;
  dueDate?: string | null;
  priority?: string;
  urgency?: string;
  isDemandingClient?: boolean;
  // Address / delivery
  city?: string;
  streetAddress?: string;
  postalCode?: string;
  deliveryType?: string;
  source?: string;
  orderDate?: string;
  // Financial
  orderDiscount?: number;
  deliveryFee?: number;
  bankCommissionPercent?: number;
  bankCommissionAmount?: number;
  // Payment
  prepayment?: number;
  paymentMethod?: string;
  expectedPaymentMethod?: string;
  paymentBreakdown?: Record<string, number>;
  items?: Array<{
    productName: string;
    fabric?: string;
    color?: string;
    gender?: string;
    length?: string;
    size: string;
    quantity: number;
    unitPrice: number;
    notes?: string;
    workshopNotes?: string;
  }>;
};

export async function update(orgId: string, id: string, authorId: string, authorName: string, data: UpdateOrderInput) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId }, include: { items: true } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (['completed', 'cancelled'].includes(order.status)) {
    throw new ValidationError('Завершённый или отменённый заказ нельзя редактировать');
  }
  if (data.items && !['new', 'confirmed'].includes(order.status)) {
    throw new ValidationError('Позиции можно изменить только до начала производства');
  }

  return prisma.$transaction(async (tx) => {
    const updateData: Record<string, unknown> = {};
    if (data.clientName) {
      const clientName = normalizeClientName(data.clientName);
      if (!clientName) {
        throw new ValidationError('Укажите имя клиента');
      }
      updateData.clientName = clientName;
    }
    if (data.clientPhone !== undefined) {
      const trimmed = data.clientPhone.trim();
      if (trimmed) {
        updateData.clientPhone = formatKazakhPhone(trimmed);
      } else {
        updateData.clientPhone = '';
      }
    }
    if (data.clientPhoneForeign !== undefined) {
      updateData.clientPhoneForeign = data.clientPhoneForeign?.trim() || null;
    }
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.priority) updateData.priority = data.priority;
    if (data.urgency !== undefined) updateData.urgency = data.urgency;
    if (data.isDemandingClient !== undefined) updateData.isDemandingClient = data.isDemandingClient;
    // Address / delivery
    if (data.city !== undefined)          updateData.city = data.city || null;
    if (data.streetAddress !== undefined) updateData.streetAddress = data.streetAddress || null;
    if (data.postalCode !== undefined)    updateData.postalCode = data.postalCode || null;
    if (data.deliveryType !== undefined)  updateData.deliveryType = data.deliveryType || null;
    if (data.source !== undefined)        updateData.source = data.source || null;
    if (data.orderDate !== undefined)     updateData.orderDate = data.orderDate ? new Date(data.orderDate) : null;
    // Financial
    if (data.orderDiscount !== undefined)        updateData.orderDiscount = data.orderDiscount ?? 0;
    if (data.deliveryFee !== undefined)          updateData.deliveryFee = data.deliveryFee ?? 0;
    if (data.bankCommissionPercent !== undefined) updateData.bankCommissionPercent = data.bankCommissionPercent ?? 0;
    if (data.bankCommissionAmount !== undefined)  updateData.bankCommissionAmount = data.bankCommissionAmount ?? 0;
    // Payment update: only replace paidAmount if prepayment is explicitly provided
    if (data.prepayment !== undefined) {
      const newPaid = Math.max(0, data.prepayment);
      updateData.paidAmount = newPaid;
      // Recalculate paymentStatus against current or incoming totalAmount
      const totalAmount = typeof updateData.totalAmount === 'number'
        ? updateData.totalAmount
        : order.totalAmount;
      updateData.paymentStatus = computePaymentStatus(newPaid, totalAmount);
    }
    if (data.expectedPaymentMethod !== undefined) updateData.expectedPaymentMethod = data.expectedPaymentMethod || null;
    if (data.paymentBreakdown !== undefined) {
      updateData.paymentBreakdown = data.paymentMethod === 'mixed'
        ? (normalizePaymentBreakdown(data.paymentBreakdown) ?? null)
        : null;
    }

    if (data.items) {
      const totalAmount = data.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
      updateData.totalAmount = totalAmount;
      updateData.paymentStatus = computePaymentStatus(order.paidAmount, totalAmount);

      // If order was already routed (confirmed), clear routing and reset to new
      // so the manager can re-assign items to warehouse/production.
      if (order.status === 'confirmed') {
        await tx.chapanProductionTask.deleteMany({ where: { orderId: id } });
        updateData.status = 'new';
      }

      await tx.chapanOrderItem.deleteMany({ where: { orderId: id } });
      for (const item of data.items) {
        const variantSnapshot = await buildOrderItemVariantSnapshot(tx, orgId, item);
        await tx.chapanOrderItem.create({
          data: {
            orderId: id,
            productName: item.productName,
            fabric: item.fabric?.trim() || '',
            color: item.color?.trim() || null,
            gender: item.gender?.trim() || null,
            length: item.length?.trim() || null,
            size: item.size,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            fulfillmentMode: 'unassigned',
            notes: item.notes,
            workshopNotes: item.workshopNotes,
            ...variantSnapshot,
          },
        });
      }
    }

    const updated = await tx.chapanOrder.update({
      where: { id },
      data: updateData,
      include: {
        items: true,
        productionTasks: true,
        payments: true,
        transfer: true,
        activities: { orderBy: { createdAt: 'desc' } },
        invoiceOrders: {
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                status: true,
                seamstressConfirmed: true,
                warehouseConfirmed: true,
              },
            },
          },
        },
      },
    });

    await tx.chapanActivity.create({
      data: { orderId: id, type: 'edit', content: 'Заказ отредактирован', authorId, authorName },
    });

    return mapOrder(updated);
  });
}

// Restore cancelled order

export async function restore(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  const isCancelled = order.status === 'cancelled' || order.status === 'canceled';
  const isArchived = order.isArchived;
  if (!isCancelled && !isArchived) {
    throw new ValidationError('Только отменённые или архивные заказы можно восстановить');
  }

  await prisma.$transaction(async (tx) => {
    const restoreData: Prisma.ChapanOrderUpdateInput = {
      isArchived: false,
      archivedAt: null,
      status: 'new', // All archived orders are restored to 'new' to allow re-confirmation
    };

    // Cancelled orders also clear their cancellation data
    if (isCancelled) {
      restoreData.cancelReason = null;
      restoreData.cancelledAt = null;
    }

    await tx.chapanOrder.update({
      where: { id },
      data: restoreData,
    });

    await tx.chapanActivity.create({
      data: { orderId: id, type: 'status_change', content: 'Заказ восстановлен → Новый', authorId, authorName },
    });
  });
}

// Archive order

export async function archive(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (!['completed', 'cancelled'].includes(order.status)) {
    throw new ValidationError('Архивировать можно только завершённые или отменённые заказы');
  }

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { isArchived: true, archivedAt: new Date() } as any,
    });

    await tx.chapanActivity.create({
      data: { orderId: id, type: 'system', content: 'Заказ перемещён в архив', authorId, authorName },
    });
  });
}

// Close order

export async function close(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: {
        select: {
          fulfillmentMode: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.isArchived) throw new ValidationError('Заказ уже находится в архиве');
  if (!['ready', 'transferred', 'on_warehouse', 'shipped', 'completed'].includes(order.status)) {
    throw new ValidationError('Закрыть сделку можно только по готовому заказу');
  }

  const now = new Date();
  const hasWarehouseItems = hasWarehouseFulfillmentItems(order.items);

  await prisma.$transaction(async (tx) => {
    await applyWarehouseOrderTransitionSideEffectsTxV2(tx, orgId, {
      orderId: id,
      fromStatus: order.status,
      toStatus: 'completed',
      hasWarehouseItems,
      authorId,
      authorName,
      consumeReservations: hasWarehouseItems,
      operationDocument: {
        documentType: 'shipment',
        idempotencyKey: `shipment:${id}`,
        payload: {
          trigger: 'order_close',
          fromStatus: order.status,
          toStatus: 'completed',
        },
      },
    });

    await tx.chapanOrder.update({
      where: { id },
      data: {
        status: 'completed',
        completedAt: order.completedAt ?? now,
        isArchived: true,
        archivedAt: now,
      },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'system',
        content: 'Сделка закрыта, заказ завершён и перемещён в архив',
        authorId,
        authorName,
      },
    });

    if (order.paymentStatus !== 'paid') {
      const balance = order.totalAmount - order.paidAmount;
      await tx.chapanActivity.create({
        data: {
          orderId: id,
          type: 'system',
          content: `⚠ Сделка закрыта с неоплаченным остатком: ${balance.toLocaleString('ru-KZ')} ₸ (статус: ${order.paymentStatus === 'not_paid' ? 'не оплачен' : 'частично оплачен'})`,
          authorId,
          authorName,
        },
      });
    }
  });

  // P3: Consume simple warehouse reservations on close (order completed)
  try {
    const { consumeSimpleOrderReservations } = await import('../warehouse/warehouse.service.js');
    await consumeSimpleOrderReservations(orgId, id, authorName);
  } catch { /* non-fatal */ }

  fireSheetSync(orgId, id);
}

export async function shipOrder(
  orgId: string,
  id: string,
  authorId: string,
  authorName: string,
  shippingData?: {
    courierType?: string;
    recipientName?: string;
    recipientAddress?: string;
    shippingNote?: string;
  },
) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: {
        select: {
          fulfillmentMode: true,
        },
      },
    },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.status !== 'on_warehouse') {
    throw new ValidationError('Отправить можно только заказ со статусом «На складе»');
  }
  if (order.paymentStatus !== 'paid') {
    const balance = order.totalAmount - order.paidAmount;
    // Log an alert activity visible to managers
    await prisma.chapanActivity.create({
      data: {
        orderId: id,
        type: 'system',
        content: `⚠ Попытка отгрузки неоплаченного заказа (остаток: ${balance.toLocaleString('ru-KZ')} ₸). Уведомите менеджера.`,
        authorId,
        authorName,
      },
    });
    throw new ValidationError('Заказ не оплачен. Отгрузка невозможна, уведомите менеджера.');
  }

  await prisma.$transaction(async (tx) => {
    const noteLines: string[] = [];
    if (shippingData?.courierType) noteLines.push(`Способ: ${shippingData.courierType}`);
    if (shippingData?.recipientName) noteLines.push(`Получатель: ${shippingData.recipientName}`);
    if (shippingData?.recipientAddress) noteLines.push(`Адрес: ${shippingData.recipientAddress}`);
    if (shippingData?.shippingNote) noteLines.push(`Комментарий: ${shippingData.shippingNote}`);
    const compiledNote = noteLines.length > 0 ? noteLines.join(' | ') : undefined;

    await applyWarehouseOrderTransitionSideEffectsTxV2(tx, orgId, {
      orderId: id,
      fromStatus: order.status,
      toStatus: 'shipped',
      hasWarehouseItems: hasWarehouseFulfillmentItems(order.items),
      authorId,
      authorName,
      consumeReservations: hasWarehouseFulfillmentItems(order.items),
      operationDocument: {
        documentType: 'shipment',
        idempotencyKey: `shipment:${id}`,
        payload: {
          trigger: 'ship_order',
          fromStatus: order.status,
          toStatus: 'shipped',
          courierType: shippingData?.courierType ?? null,
        },
      },
    });

    await tx.chapanOrder.update({
      where: { id },
      data: {
        status: 'shipped',
        shippingNote: compiledNote ?? undefined,
      },
    });
    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'system',
        content: compiledNote
          ? `Заказ отправлен клиенту — ${compiledNote}`
          : 'Заказ отправлен клиенту',
        authorId,
        authorName,
      },
    });
  });

  // P3: Consume simple (non-canonical) warehouse reservations on shipment
  try {
    const { consumeSimpleOrderReservations } = await import('../warehouse/warehouse.service.js');
    await consumeSimpleOrderReservations(orgId, id, authorName);
  } catch { /* non-fatal */ }

  fireSheetSync(orgId, id);
}

export async function addActivity(orgId: string, orderId: string, authorId: string, authorName: string, data: {
  type: string;
  content: string;
}) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  return prisma.chapanActivity.create({
    data: {
      orderId,
      type: data.type,
      content: data.content,
      authorId,
      authorName,
    },
  });
}

// ── Change Requests ────────────────────────────────────────────────────────────

type ProposedItem = {
  productName: string;
  fabric?: string;
  size: string;
  quantity: number;
  unitPrice: number;
  notes?: string;
  workshopNotes?: string;
};

export async function requestItemChange(
  orgId: string,
  orderId: string,
  authorId: string,
  authorName: string,
  proposedItems: ProposedItem[],
  managerNote?: string,
) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);
  if (order.status !== 'in_production') {
    throw new ValidationError('Запрос на изменение возможен только для заказов в производстве');
  }

  // Cancel any previous pending request for this order
  await prisma.chapanChangeRequest.updateMany({
    where: { orderId, status: 'pending' },
    data: { status: 'rejected', rejectReason: 'Заменён новым запросом', resolvedBy: authorName },
  });

  const changeRequest = await prisma.chapanChangeRequest.create({
    data: {
      orderId,
      orgId,
      requestedBy: authorName,
      proposedItems: proposedItems as unknown as Prisma.InputJsonValue,
      managerNote: managerNote?.trim() || null,
    },
  });

  await prisma.chapanActivity.create({
    data: {
      orderId,
      type: 'system',
      content: `Менеджер ${authorName} запросил изменение позиций заказа. Ожидает согласования цеха.`,
      authorId,
      authorName,
    },
  });

  return changeRequest;
}

export async function listPendingChangeRequests(orgId: string) {
  const requests = await prisma.chapanChangeRequest.findMany({
    where: { orgId, status: 'pending' },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          clientName: true,
          priority: true,
          status: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  return requests;
}

export async function approveChangeRequest(
  orgId: string,
  changeRequestId: string,
  authorId: string,
  authorName: string,
) {
  const changeRequest = await prisma.chapanChangeRequest.findFirst({
    where: { id: changeRequestId, orgId, status: 'pending' },
  });
  if (!changeRequest) throw new NotFoundError('ChapanChangeRequest', changeRequestId);

  const order = await prisma.chapanOrder.findFirst({
    where: { id: changeRequest.orderId, orgId },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', changeRequest.orderId);

  const proposedItems = changeRequest.proposedItems as ProposedItem[];

  await prisma.$transaction(async (tx) => {
    await tx.chapanChangeRequest.update({
      where: { id: changeRequestId },
      data: { status: 'approved', resolvedBy: authorName },
    });

    // ── Diff: only ADD items that don't exist yet ────────────────────────────
    // We match by (productName, size, fabric) tuple — exact matches are kept as-is.
    // New entries (not matching any current item) get a new OrderItem + queued ProductionTask.
    // Existing tasks are NEVER deleted — seamstress keeps her current work.

    const currentItems = order.items;

    function itemKey(productName: string, size: string, fabric?: string | null) {
      return `${productName}|${size}|${(fabric ?? '').toLowerCase().trim()}`;
    }

    const existingKeys = new Set(currentItems.map((i) => itemKey(i.productName, i.size, i.fabric)));

    const addedItems = proposedItems.filter(
      (p) => !existingKeys.has(itemKey(p.productName, p.size, p.fabric)),
    );

    // Update prices/notes on existing items (non-disruptive — no task changes)
    for (const proposed of proposedItems) {
      const key = itemKey(proposed.productName, proposed.size, proposed.fabric);
      const existing = currentItems.find((i) => itemKey(i.productName, i.size, i.fabric) === key);
      if (existing) {
        const variantSnapshot = await buildOrderItemVariantSnapshot(tx, orgId, proposed);
        await tx.chapanOrderItem.update({
          where: { id: existing.id },
          data: {
            unitPrice: proposed.unitPrice,
            quantity: proposed.quantity,
            workshopNotes: proposed.workshopNotes ?? existing.workshopNotes,
            ...variantSnapshot,
          },
        });
      }
    }

    // Create new items and their production tasks (queued)
    for (const item of addedItems) {
      const variantSnapshot = await buildOrderItemVariantSnapshot(tx, orgId, item);
      const newItem = await tx.chapanOrderItem.create({
        data: {
          orderId: order.id,
          productName: item.productName,
          fabric: item.fabric?.trim() || '',
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          fulfillmentMode: 'production',
          workshopNotes: item.workshopNotes,
          ...variantSnapshot,
        },
      });

      await tx.chapanProductionTask.create({
        data: {
          orderId: order.id,
          orderItemId: newItem.id,
          productName: item.productName,
          fabric: item.fabric?.trim() || '',
          size: item.size,
          quantity: item.quantity,
          status: 'queued',
          notes: item.workshopNotes,
        },
      });
    }

    // Recalculate total from all current items (existing updated + new)
    const allItems = await tx.chapanOrderItem.findMany({ where: { orderId: order.id } });
    const totalAmount = allItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

    await tx.chapanOrder.update({
      where: { id: order.id },
      data: {
        totalAmount,
        paymentStatus: computePaymentStatus(order.paidAmount, totalAmount),
        // Status stays in_production — seamstress keeps her existing tasks
      },
    });

    const addedSummary = addedItems.length > 0
      ? `Добавлены новые позиции: ${addedItems.map((i) => `${i.productName} / ${i.size}`).join(', ')}.`
      : 'Изменены данные существующих позиций.';

    await tx.chapanActivity.create({
      data: {
        orderId: order.id,
        type: 'system',
        content: `Цех согласовал изменение позиций (${authorName}). ${addedSummary} Производство продолжается.`,
        authorId,
        authorName,
      },
    });
  });
}

export async function rejectChangeRequest(
  orgId: string,
  changeRequestId: string,
  authorId: string,
  authorName: string,
  rejectReason: string,
) {
  const changeRequest = await prisma.chapanChangeRequest.findFirst({
    where: { id: changeRequestId, orgId, status: 'pending' },
  });
  if (!changeRequest) throw new NotFoundError('ChapanChangeRequest', changeRequestId);

  await prisma.$transaction(async (tx) => {
    await tx.chapanChangeRequest.update({
      where: { id: changeRequestId },
      data: { status: 'rejected', rejectReason: rejectReason.trim(), resolvedBy: authorName },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: changeRequest.orderId,
        type: 'system',
        content: `Цех отклонил изменение позиций (${authorName}): ${rejectReason.trim()}`,
        authorId,
        authorName,
      },
    });
  });
}

export async function routeSingleItem(
  orgId: string,
  orderId: string,
  itemId: string,
  fulfillmentMode: 'warehouse' | 'production',
  authorId: string,
  authorName: string,
) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);
  if (!['new', 'confirmed'].includes(order.status)) {
    throw new ValidationError('Маршрутизацию позиции можно задать только для нового или подтверждённого заказа');
  }
  const item = order.items.find((i) => i.id === itemId);
  if (!item) throw new NotFoundError('ChapanOrderItem', itemId);

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrderItem.update({ where: { id: itemId }, data: { fulfillmentMode } });

    if (fulfillmentMode === 'production') {
      await tx.chapanProductionTask.upsert({
        where: { orderItemId: itemId },
        create: {
          orderId,
          orderItemId: itemId,
          productName: item.productName,
          fabric: item.fabric ?? '',
          size: item.size,
          quantity: item.quantity,
          status: 'queued',
          notes: item.workshopNotes,
        },
        update: { status: 'queued' },
      });
    } else {
      await tx.chapanProductionTask.deleteMany({ where: { orderItemId: itemId } });
    }

    if (order.status === 'new') {
      await tx.chapanOrder.update({ where: { id: orderId }, data: { status: 'confirmed' } });
    }

    const label = fulfillmentMode === 'production' ? 'отправлена в цех' : 'направлена напрямую на склад';
    await tx.chapanActivity.create({
      data: {
        orderId,
        type: 'system',
        content: `Позиция «${item.productName} / ${item.size}» ${label} (${authorName}).`,
        authorId,
        authorName,
      },
    });
  });
}


// ── Trash (soft-delete) ───────────────────────────────────────────────────────

/** Manager moves an order to trash (soft-delete). Owner can permanently delete. */
export async function trashOrder(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.deletedAt) throw new ValidationError('Заказ уже в корзине.');
  if (['completed', 'cancelled'].includes(order.status)) {
    // Allow trashing completed/cancelled orders
  }

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    await tx.chapanActivity.create({
      data: { orderId: id, type: 'edit', content: 'Заказ перемещён в корзину', authorId, authorName },
    });
  });

  return { ok: true };
}

/** Restore an order from trash. Owner/full_access only. */
export async function restoreFromTrash(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (!order.deletedAt) throw new ValidationError('Заказ не в корзине.');

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id },
      data: { deletedAt: null },
    });
    await tx.chapanActivity.create({
      data: { orderId: id, type: 'edit', content: 'Заказ восстановлен из корзины', authorId, authorName },
    });
  });

  return { ok: true };
}

/** Permanently delete an order. Owner/full_access only. */
export async function permanentDelete(orgId: string, id: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: { items: true, productionTasks: true, payments: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (!order.deletedAt) {
    throw new ValidationError(
      'Заказ не в корзине. Сначала переместите его в корзину.',
    );
  }

  // Hard delete — cascades to items, tasks, payments via Prisma relations
  await prisma.chapanOrder.delete({ where: { id } });

  return { ok: true };
}

/** List trashed orders. Owner/full_access only. */
export async function listTrashed(orgId: string) {
  return prisma.chapanOrder.findMany({
    where: { orgId, deletedAt: { not: null } },
    include: { items: true, payments: true },
    orderBy: { deletedAt: 'desc' },
  });
}

// ── Manager reassignment ───────────────────────────────────────────────────────

/**
 * Reassign an order to a different manager.
 * Caller must have already verified that actorId has permission to perform this action.
 */
export async function reassignManager(
  orgId: string,
  orderId: string,
  newManagerId: string,
  newManagerName: string,
  actorId: string,
  actorName: string,
) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  const prevManagerName = order.managerName ?? 'Не назначен';

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id: orderId },
      data: { managerId: newManagerId, managerName: newManagerName },
    });

    await tx.chapanActivity.create({
      data: {
        orderId,
        type: 'manager_reassign',
        content: `Менеджер изменён: ${prevManagerName} → ${newManagerName}`,
        authorId: actorId,
        authorName: actorName,
      },
    });
  });

  return getById(orgId, orderId);
}

/**
 * List all active org members available for selection as order manager.
 * Returns minimal shape: id + name (+ role for display hint).
 */
export async function listOrgManagers(orgId: string) {
  const memberships = await prisma.membership.findMany({
    where: {
      orgId,
      status: 'active',
      NOT: { employeeAccountStatus: 'dismissed' },
    },
    include: { user: { select: { id: true, fullName: true } } },
    orderBy: { joinedAt: 'asc' },
  });

  return memberships.map((m) => ({
    id: m.userId,
    name: m.user.fullName,
    role: m.role,
  }));
}

