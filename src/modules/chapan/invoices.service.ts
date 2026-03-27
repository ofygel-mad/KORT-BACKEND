import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { getNextInvoiceNumberCandidate } from './invoice-number.js';
import {
  buildInvoiceDocumentPayload,
  normalizeInvoiceDocumentPayload,
  type InvoiceDocumentPayload,
} from './invoice-document.js';

const INVOICE_MODULE_NOT_READY_MESSAGE = 'Модуль накладных не инициализирован. Выполните миграции БД.';

function isMissingInvoiceSchemaError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code === 'P2021') {
    const table = String(error.meta?.table ?? '');
    return table.includes('chapan_invoices') || table.includes('chapan_invoice_orders');
  }

  if (error.code === 'P2022') {
    const column = String(error.meta?.column ?? '');
    return column.includes('invoice_')
      || column.includes('warehouse_confirmed')
      || column.includes('seamstress_confirmed')
      || column.includes('document_payload');
  }

  return false;
}

function wrapInvoiceSchemaError(error: unknown): never {
  if (isMissingInvoiceSchemaError(error)) {
    throw new AppError(503, INVOICE_MODULE_NOT_READY_MESSAGE, 'INVOICE_MODULE_NOT_READY');
  }

  throw error;
}

function isInvoiceNumberConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  const target = JSON.stringify(error.meta?.target ?? '');
  return target.includes('org_id') && target.includes('invoice_number');
}

async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  orgId: string,
  createdAt: Date,
): Promise<string> {
  return getNextInvoiceNumberCandidate(tx, orgId, createdAt);
}

function buildFallbackDocument(invoice: {
  invoiceNumber: string;
  createdAt: Date;
  items: Array<{
    order: {
      id: string;
      orderNumber: string;
      items: Array<{
        productName: string;
        fabric?: string | null;
        size: string;
        quantity: number;
        unitPrice: number;
        color?: string | null;
      }>;
    };
  }>;
}): InvoiceDocumentPayload {
  return buildInvoiceDocumentPayload({
    invoiceNumber: invoice.invoiceNumber,
    createdAt: invoice.createdAt,
    orders: invoice.items.map((item) => ({
      id: item.order.id,
      orderNumber: item.order.orderNumber,
      items: item.order.items,
    })),
  });
}

async function loadInvoiceSourceOrders(
  db: Prisma.TransactionClient | typeof prisma,
  orgId: string,
  orderIds: string[],
) {
  return db.chapanOrder.findMany({
    where: { id: { in: orderIds }, orgId },
    include: {
      items: {
        select: {
          productName: true,
          fabric: true,
          size: true,
          quantity: true,
          unitPrice: true,
          color: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createInvoice(
  orgId: string,
  createdById: string,
  createdByName: string,
  orderIds: string[],
  notes?: string,
  documentPayload?: unknown,
) {
  try {
    const orders = await prisma.chapanOrder.findMany({
      where: { id: { in: orderIds }, orgId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        orderNumber: true,
        totalAmount: true,
        paidAmount: true,
      },
    });

    if (orders.length !== orderIds.length) {
      throw new ValidationError('Некоторые заказы не найдены');
    }

    const notReady = orders.filter((order) => order.status !== 'ready');
    if (notReady.length > 0) {
      throw new ValidationError(
        `Заказы должны быть в статусе "Готово": ${notReady.map((order) => order.orderNumber).join(', ')}`,
      );
    }

    const unpaid = orders.filter((order) => order.paymentStatus !== 'paid');
    if (unpaid.length > 0) {
      throw new ValidationError(
        `Невозможно передать неоплаченные заказы: ${unpaid
          .map((order) => `${order.orderNumber} (остаток: ${(order.totalAmount - order.paidAmount).toLocaleString('ru-KZ')} ₸)`)
          .join(', ')}`,
      );
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          const existingPending = await tx.chapanInvoiceOrder.findMany({
            where: {
              orderId: { in: orderIds },
              invoice: { status: 'pending_confirmation' },
            },
            select: { invoice: { select: { invoiceNumber: true } } },
          });

          if (existingPending.length > 0) {
            const nums = [...new Set(existingPending.map((row) => row.invoice.invoiceNumber))].join(', ');
            throw new ValidationError(`Для этих заказов уже существует накладная в ожидании подтверждения: ${nums}`);
          }

          const createdAt = new Date();
          const invoiceNumber = await nextInvoiceNumber(tx, orgId, createdAt);
          const detailedOrders = await loadInvoiceSourceOrders(tx, orgId, orderIds);
          const fallbackDocument = buildInvoiceDocumentPayload({
            invoiceNumber,
            createdAt,
            orders: detailedOrders.map((order) => ({
              id: order.id,
              orderNumber: order.orderNumber,
              items: order.items,
            })),
          });
          const normalizedDocument = documentPayload
            ? normalizeInvoiceDocumentPayload(documentPayload, fallbackDocument)
            : fallbackDocument;

          const invoice = await tx.chapanInvoice.create({
            data: {
              orgId,
              invoiceNumber,
              createdById,
              createdByName,
              notes,
              createdAt,
              ...({ documentPayload: normalizedDocument } as Record<string, unknown>),
              items: {
                create: orderIds.map((orderId) => ({ orderId })),
              },
            },
            include: {
              items: {
                include: {
                  order: {
                    include: { items: true },
                  },
                },
              },
            },
          });

          for (const orderId of orderIds) {
            await tx.chapanActivity.create({
              data: {
                orderId,
                type: 'system',
                content: `Включён в накладную ${invoiceNumber}`,
                authorId: createdById,
                authorName: createdByName,
              },
            });
          }

          return {
            ...invoice,
            documentPayload: normalizedDocument,
          };
        });
      } catch (error) {
        if (isInvoiceNumberConflict(error) && attempt < 4) {
          continue;
        }
        throw error;
      }
    }

    throw new ValidationError('Не удалось сформировать уникальный номер накладной');
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function previewInvoiceDocument(orgId: string, orderIds: string[]) {
  const orders = await prisma.chapanOrder.findMany({
    where: { id: { in: orderIds }, orgId },
    select: {
      id: true,
      status: true,
      orderNumber: true,
    },
  });

  if (orders.length !== orderIds.length) {
    throw new ValidationError('Некоторые заказы не найдены');
  }

  const notReady = orders.filter((order) => order.status !== 'ready');
  if (notReady.length > 0) {
    throw new ValidationError(
      `Для preview все заказы должны быть в статусе "Готово": ${notReady.map((order) => order.orderNumber).join(', ')}`,
    );
  }

  const createdAt = new Date();
  const invoiceNumber = await getNextInvoiceNumberCandidate(prisma, orgId, createdAt);
  const detailedOrders = await loadInvoiceSourceOrders(prisma, orgId, orderIds);
  return buildInvoiceDocumentPayload({
    invoiceNumber,
    createdAt,
    orders: detailedOrders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      items: order.items,
    })),
  });
}

export async function listInvoices(
  orgId: string,
  filters?: { status?: string; orderId?: string; limit?: number; offset?: number },
) {
  try {
    const where: Prisma.ChapanInvoiceWhereInput = { orgId };
    if (filters?.status) where.status = filters.status;
    if (filters?.orderId) {
      where.items = { some: { orderId: filters.orderId } };
    }

    const [results, count] = await Promise.all([
      prisma.chapanInvoice.findMany({
        where,
        include: {
          items: {
            include: {
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  clientName: true,
                  clientPhone: true,
                  status: true,
                  paymentStatus: true,
                  totalAmount: true,
                  paidAmount: true,
                  dueDate: true,
                  items: {
                    select: {
                      productName: true,
                      fabric: true,
                      size: true,
                      quantity: true,
                      unitPrice: true,
                    },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: filters?.limit ?? 100,
        skip: filters?.offset ?? 0,
      }),
      prisma.chapanInvoice.count({ where }),
    ]);

    return { results, count };
  } catch (error) {
    if (isMissingInvoiceSchemaError(error)) {
      return { results: [], count: 0 };
    }

    throw error;
  }
}

export async function getInvoice(orgId: string, id: string) {
  try {
    const invoice = await prisma.chapanInvoice.findFirst({
      where: { id, orgId },
      include: {
        items: {
          include: {
            order: {
              include: { items: true, payments: true },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundError('ChapanInvoice', id);
    }

    const fallbackDocument = buildFallbackDocument(invoice);
    const storedDocumentPayload = (invoice as typeof invoice & { documentPayload?: unknown }).documentPayload;
    return {
      ...invoice,
      documentPayload: normalizeInvoiceDocumentPayload(storedDocumentPayload, fallbackDocument),
    };
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function updateInvoiceDocument(
  orgId: string,
  invoiceId: string,
  documentPayload: unknown,
) {
  try {
    const invoice = await prisma.chapanInvoice.findFirst({
      where: { id: invoiceId, orgId },
      include: {
        items: {
          include: {
            order: {
              include: { items: true, payments: true },
            },
          },
        },
      },
    });

    if (!invoice) {
      throw new NotFoundError('ChapanInvoice', invoiceId);
    }

    const fallbackDocument = buildFallbackDocument(invoice);
    const normalizedDocument = normalizeInvoiceDocumentPayload(documentPayload, fallbackDocument);
    await prisma.chapanInvoice.update({
      where: { id: invoiceId },
      data: { ...({ documentPayload: normalizedDocument } as Record<string, unknown>) },
    });

    return {
      ...invoice,
      documentPayload: normalizedDocument,
    };
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function confirmBySeamstress(
  orgId: string,
  invoiceId: string,
  userId: string,
  userName: string,
) {
  try {
    const invoice = await prisma.chapanInvoice.findFirst({
      where: { id: invoiceId, orgId },
      include: { items: true },
    });

    if (!invoice) {
      throw new NotFoundError('ChapanInvoice', invoiceId);
    }
    if (invoice.status === 'rejected') {
      throw new ValidationError('Накладная отклонена');
    }
    if (invoice.seamstressConfirmed) {
      throw new ValidationError('Швея уже подтвердила');
    }

    const now = new Date();
    const bothConfirmed = invoice.warehouseConfirmed;

    await prisma.$transaction(async (tx) => {
      await tx.chapanInvoice.update({
        where: { id: invoiceId },
        data: {
          seamstressConfirmed: true,
          seamstressConfirmedAt: now,
          seamstressConfirmedBy: userName,
          ...(bothConfirmed ? { status: 'confirmed' } : {}),
        },
      });

      if (bothConfirmed) {
        await advanceOrdersToWarehouse(tx, invoice.items, userId, userName, invoice.invoiceNumber);
      }
    });

    return { bothConfirmed };
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function confirmByWarehouse(
  orgId: string,
  invoiceId: string,
  userId: string,
  userName: string,
) {
  try {
    const invoice = await prisma.chapanInvoice.findFirst({
      where: { id: invoiceId, orgId },
      include: { items: true },
    });

    if (!invoice) {
      throw new NotFoundError('ChapanInvoice', invoiceId);
    }
    if (invoice.status === 'rejected') {
      throw new ValidationError('Накладная отклонена');
    }
    if (invoice.warehouseConfirmed) {
      throw new ValidationError('Склад уже подтвердил');
    }

    const now = new Date();
    const bothConfirmed = invoice.seamstressConfirmed;

    await prisma.$transaction(async (tx) => {
      await tx.chapanInvoice.update({
        where: { id: invoiceId },
        data: {
          warehouseConfirmed: true,
          warehouseConfirmedAt: now,
          warehouseConfirmedBy: userName,
          ...(bothConfirmed ? { status: 'confirmed' } : {}),
        },
      });

      if (bothConfirmed) {
        await advanceOrdersToWarehouse(tx, invoice.items, userId, userName, invoice.invoiceNumber);
      }
    });

    return { bothConfirmed };
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function rejectInvoice(
  orgId: string,
  invoiceId: string,
  userId: string,
  userName: string,
  reason: string,
) {
  try {
    const invoice = await prisma.chapanInvoice.findFirst({
      where: { id: invoiceId, orgId },
      include: { items: true },
    });

    if (!invoice) {
      throw new NotFoundError('ChapanInvoice', invoiceId);
    }
    if (invoice.status === 'confirmed') {
      throw new ValidationError('Нельзя отклонить подтверждённую накладную');
    }

    await prisma.$transaction(async (tx) => {
      await tx.chapanInvoice.update({
        where: { id: invoiceId },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
          rejectedBy: userName,
          rejectionReason: reason,
        },
      });

      for (const item of invoice.items) {
        await tx.chapanActivity.create({
          data: {
            orderId: item.orderId,
            type: 'system',
            content: `Накладная ${invoice.invoiceNumber} отклонена: ${reason}`,
            authorId: userId,
            authorName: userName,
          },
        });
      }
    });
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

async function advanceOrdersToWarehouse(
  tx: Prisma.TransactionClient,
  items: Array<{ orderId: string }>,
  userId: string,
  userName: string,
  invoiceNumber: string,
) {
  for (const item of items) {
    await tx.chapanOrder.update({
      where: { id: item.orderId },
      data: { status: 'on_warehouse' },
    });

    await tx.chapanActivity.create({
      data: {
        orderId: item.orderId,
        type: 'status_change',
        content: `Готово -> На складе (накладная ${invoiceNumber})`,
        authorId: userId,
        authorName: userName,
      },
    });
  }
}
