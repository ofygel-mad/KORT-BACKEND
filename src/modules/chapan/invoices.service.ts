import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError, NotFoundError, ValidationError } from '../../lib/errors.js';

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
      || column.includes('seamstress_confirmed');
  }

  return false;
}

function wrapInvoiceSchemaError(error: unknown): never {
  if (isMissingInvoiceSchemaError(error)) {
    throw new AppError(503, INVOICE_MODULE_NOT_READY_MESSAGE, 'INVOICE_MODULE_NOT_READY');
  }

  throw error;
}

async function nextInvoiceNumber(orgId: string): Promise<string> {
  try {
    const profile = await prisma.chapanProfile.update({
      where: { orgId },
      data: { invoiceCounter: { increment: 1 } },
    });
    const prefix = profile.orderPrefix || 'ЧП';
    return `${prefix}-Н${String(profile.invoiceCounter).padStart(3, '0')}`;
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function createInvoice(
  orgId: string,
  createdById: string,
  createdByName: string,
  orderIds: string[],
  notes?: string,
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

    const invoiceNumber = await nextInvoiceNumber(orgId);

    return await prisma.$transaction(async (tx) => {
      const invoice = await tx.chapanInvoice.create({
        data: {
          orgId,
          invoiceNumber,
          createdById,
          createdByName,
          notes,
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

      return invoice;
    });
  } catch (error) {
    wrapInvoiceSchemaError(error);
  }
}

export async function listInvoices(
  orgId: string,
  filters?: { status?: string; limit?: number; offset?: number },
) {
  try {
    const where: Record<string, unknown> = { orgId };
    if (filters?.status) where.status = filters.status;

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

    return invoice;
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
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
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
