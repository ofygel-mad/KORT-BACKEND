import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';

type CreateOrderInput = {
  clientId?: string;
  clientName: string;
  clientPhone: string;
  priority: string;
  items: Array<{
    productName: string;
    fabric: string;
    size: string;
    quantity: number;
    unitPrice: number;
    notes?: string;
    workshopNotes?: string;
  }>;
  dueDate?: string;
  sourceRequestId?: string;
};

// ── Helpers ─────────────────────────────────────────────

async function nextOrderNumber(orgId: string): Promise<string> {
  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  const prefix = (profile?.orderPrefix ?? 'ЧП').trim().slice(0, 6).toUpperCase();
  const counter = (profile?.orderCounter ?? 0) + 1;

  await prisma.chapanProfile.update({
    where: { orgId },
    data: { orderCounter: counter },
  });

  return `${prefix}-${String(counter).padStart(3, '0')}`;
}

function computePaymentStatus(paidAmount: number, totalAmount: number): string {
  if (paidAmount >= totalAmount) return 'paid';
  if (paidAmount > 0) return 'partial';
  return 'not_paid';
}

async function resolveOrderClient(
  tx: Prisma.TransactionClient,
  orgId: string,
  data: Pick<CreateOrderInput, 'clientId' | 'clientName' | 'clientPhone'>,
) {
  const clientId = data.clientId?.trim();
  const clientName = data.clientName.trim();
  const clientPhone = data.clientPhone.trim();

  if (!clientName) {
    throw new ValidationError('Укажите имя клиента');
  }
  if (!clientPhone) {
    throw new ValidationError('Укажите телефон клиента');
  }

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
    };
  }

  const existingClient = await tx.chapanClient.findFirst({
    where: { orgId, phone: clientPhone },
    orderBy: { createdAt: 'desc' },
  });

  if (existingClient) {
    return {
      clientId: existingClient.id,
      clientName,
      clientPhone,
    };
  }

  const createdClient = await tx.chapanClient.create({
    data: {
      orgId,
      fullName: clientName,
      phone: clientPhone,
    },
  });

  return {
    clientId: createdClient.id,
    clientName,
    clientPhone,
  };
}

// ── List orders ─────────────────────────────────────────

export async function list(orgId: string, filters?: {
  status?: string;
  priority?: string;
  paymentStatus?: string;
  search?: string;
  sortBy?: string;
}) {
  const where: Record<string, unknown> = { orgId };

  if (filters?.status && filters.status !== 'all') {
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

  return prisma.chapanOrder.findMany({
    where,
    orderBy,
    include: {
      items: true,
      productionTasks: true,
      payments: true,
      transfer: true,
      activities: { orderBy: { createdAt: 'desc' } },
    },
  });
}

// ── Get single order ────────────────────────────────────

export async function getById(orgId: string, id: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: {
      items: true,
      productionTasks: true,
      payments: true,
      transfer: true,
      activities: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  return order;
}

// ── Create order ────────────────────────────────────────

export async function create(orgId: string, authorId: string, authorName: string, data: CreateOrderInput) {
  const orderNumber = await nextOrderNumber(orgId);
  const totalAmount = data.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);

  return prisma.$transaction(async (tx) => {
    const client = await resolveOrderClient(tx, orgId, data);

    const order = await tx.chapanOrder.create({
      data: {
        orgId,
        orderNumber,
        clientId: client.clientId,
        clientName: client.clientName,
        clientPhone: client.clientPhone,
        priority: data.priority,
        totalAmount,
        dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
        items: {
          create: data.items.map((item) => ({
            productName: item.productName,
            fabric: item.fabric,
            size: item.size,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            notes: item.notes,
            workshopNotes: item.workshopNotes,
          })),
        },
        activities: {
          create: {
            type: 'system',
            content: 'Заказ создан',
            authorId,
            authorName,
          },
        },
      },
      include: {
        items: true,
        productionTasks: true,
        payments: true,
        activities: true,
      },
    });

    if (data.sourceRequestId) {
      await tx.chapanRequest.updateMany({
        where: { id: data.sourceRequestId, orgId },
        data: { status: 'converted', createdOrderId: order.id },
      });
    }

    return order;
  });
}

// ── Confirm order (creates production tasks) ────────────

export async function confirm(orgId: string, id: string, authorId: string, authorName: string) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id, orgId },
    include: { items: true },
  });
  if (!order) throw new NotFoundError('ChapanOrder', id);
  if (order.status !== 'new') throw new ValidationError('Only new orders can be confirmed');

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id },
      data: { status: 'confirmed' },
    });

    // Auto-create production tasks from items
    for (const item of order.items) {
      await tx.chapanProductionTask.create({
        data: {
          orderId: id,
          orderItemId: item.id,
          productName: item.productName,
          fabric: item.fabric,
          size: item.size,
          quantity: item.quantity,
        },
      });
    }

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'status_change',
        content: 'Новый → Подтверждён',
        authorId,
        authorName,
      },
    });
  });

  // After confirmation: async warehouse BOM check (non-blocking)
  // If BOM is set up, this will auto-reserve materials or block tasks on shortage
  try {
    const { checkOrderBOM } = await import('../warehouse/warehouse.service.js');
    await checkOrderBOM(orgId, id, true);
  } catch {
    // Warehouse module may not have BOM set up yet — not a fatal error
  }
}

// ── Update order status ─────────────────────────────────

export async function updateStatus(orgId: string, id: string, status: string, authorId: string, authorName: string, cancelReason?: string) {
  const order = await prisma.chapanOrder.findFirst({ where: { id, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', id);

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.chapanOrder.update({
      where: { id },
      data: {
        status,
        completedAt: status === 'completed' ? now : undefined,
        cancelledAt: status === 'cancelled' ? now : undefined,
        cancelReason: status === 'cancelled' ? cancelReason : undefined,
      },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: id,
        type: 'status_change',
        content: `${order.status} → ${status}`,
        authorId,
        authorName,
      },
    });
  });

  // Release warehouse reservations on terminal statuses
  if (status === 'cancelled' || status === 'completed') {
    try {
      const { releaseOrderReservations } = await import('../warehouse/warehouse.service.js');
      await releaseOrderReservations(orgId, id);
    } catch {
      // Warehouse module may not have reservations — not fatal
    }
  }
}

// ── Add payment ─────────────────────────────────────────

export async function addPayment(orgId: string, orderId: string, authorId: string, authorName: string, data: {
  amount: number;
  method: string;
  notes?: string;
}) {
  const order = await prisma.chapanOrder.findFirst({ where: { id: orderId, orgId } });
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  const newPaidAmount = order.paidAmount + data.amount;

  const [payment] = await prisma.$transaction([
    prisma.chapanPayment.create({
      data: {
        orderId,
        amount: data.amount,
        method: data.method,
        notes: data.notes,
      },
    }),
    prisma.chapanOrder.update({
      where: { id: orderId },
      data: {
        paidAmount: newPaidAmount,
        paymentStatus: computePaymentStatus(newPaidAmount, order.totalAmount),
      },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId,
        type: 'payment',
        content: `Оплата ${data.amount.toLocaleString('ru-RU')} ₸ (${data.method})`,
        authorId,
        authorName,
      },
    }),
  ]);

  return payment;
}

// ── Transfer ────────────────────────────────────────────

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

  // Both confirmed → mark as transferred
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

// ── Add activity ────────────────────────────────────────

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
