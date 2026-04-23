import { prisma } from '../../lib/prisma.js';
import { AppError, NotFoundError } from '../../lib/errors.js';
import { addMovement } from '../warehouse/warehouse.service.js';

// ── Return number generation ──────────────────────────────────────────────────

async function nextReturnNumber(orgId: string): Promise<string> {
  const last = await prisma.chapanReturn.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { returnNumber: true },
  });

  if (!last) return 'RET-0001';

  const match = last.returnNumber.match(/^RET-(\d+)$/);
  const seq = match?.[1] ? parseInt(match[1], 10) + 1 : 1;
  return `RET-${String(seq).padStart(4, '0')}`;
}

// ── Selects ───────────────────────────────────────────────────────────────────

const returnWithItems = {
  id: true,
  orgId: true,
  returnNumber: true,
  orderId: true,
  status: true,
  reason: true,
  reasonNotes: true,
  createdById: true,
  createdByName: true,
  confirmedAt: true,
  confirmedBy: true,
  totalRefundAmount: true,
  refundMethod: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      clientName: true,
      clientPhone: true,
      status: true,
    },
  },
  items: {
    select: {
      id: true,
      returnId: true,
      orderItemId: true,
      productName: true,
      size: true,
      color: true,
      gender: true,
      qty: true,
      unitPrice: true,
      refundAmount: true,
      condition: true,
      warehouseItemId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface CreateReturnItemDto {
  orderItemId?: string;
  productName: string;
  size: string;
  color?: string;
  gender?: string;
  qty: number;
  unitPrice: number;
  refundAmount: number;
  condition: 'good' | 'defective' | 'damaged';
  warehouseItemId?: string;
}

export interface CreateReturnDto {
  orderId: string;
  reason: 'defect' | 'wrong_size' | 'wrong_item' | 'customer_refusal' | 'other';
  reasonNotes?: string;
  refundMethod: 'cash' | 'bank';
  items: CreateReturnItemDto[];
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function list(
  orgId: string,
  filters: { orderId?: string; status?: string } = {},
) {
  return prisma.chapanReturn.findMany({
    where: {
      orgId,
      ...(filters.orderId ? { orderId: filters.orderId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    select: returnWithItems,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getById(orgId: string, id: string) {
  const ret = await prisma.chapanReturn.findFirst({
    where: { id, orgId },
    select: returnWithItems,
  });
  if (!ret) throw new NotFoundError('Акт возврата не найден');
  return ret;
}

export async function create(
  orgId: string,
  userId: string,
  userName: string,
  dto: CreateReturnDto,
) {
  const order = await prisma.chapanOrder.findFirst({
    where: { id: dto.orderId, orgId },
    select: { id: true, status: true },
  });
  if (!order) throw new NotFoundError('Заказ не найден');

  if (!['shipped', 'completed'].includes(order.status)) {
    throw new AppError(
      400,
      'Возврат можно оформить только для отправленных или завершённых заказов',
      'INVALID_ORDER_STATUS',
    );
  }

  if (dto.items.length === 0) {
    throw new AppError(400, 'Укажите хотя бы одну позицию для возврата', 'EMPTY_ITEMS');
  }

  const totalRefundAmount = dto.items.reduce((sum, i) => sum + i.refundAmount, 0);
  const returnNumber = await nextReturnNumber(orgId);

  return prisma.chapanReturn.create({
    data: {
      orgId,
      returnNumber,
      orderId: dto.orderId,
      status: 'draft',
      reason: dto.reason,
      reasonNotes: dto.reasonNotes,
      createdById: userId,
      createdByName: userName,
      totalRefundAmount,
      refundMethod: dto.refundMethod,
      items: {
        create: dto.items.map((item) => ({
          orderItemId: item.orderItemId,
          productName: item.productName,
          size: item.size,
          color: item.color,
          gender: item.gender,
          qty: item.qty,
          unitPrice: item.unitPrice,
          refundAmount: item.refundAmount,
          condition: item.condition,
          warehouseItemId: item.warehouseItemId,
        })),
      },
    },
    select: returnWithItems,
  });
}

export async function confirm(
  orgId: string,
  id: string,
  userId: string,
  userName: string,
) {
  const ret = await prisma.chapanReturn.findFirst({
    where: { id, orgId },
    include: { items: true },
  });
  if (!ret) throw new NotFoundError('Акт возврата не найден');
  if (ret.status !== 'draft') {
    throw new AppError(400, 'Возврат уже подтверждён', 'ALREADY_CONFIRMED');
  }

  // Confirm the return record
  const updated = await prisma.$transaction(async (tx) => {
    const confirmed = await tx.chapanReturn.update({
      where: { id },
      data: {
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedBy: userName,
      },
      select: returnWithItems,
    });

    // Mark order as having returns
    await tx.chapanOrder.update({
      where: { id: ret.orderId },
      data: { hasReturns: true },
    });

    // Log activity on the order
    await tx.chapanActivity.create({
      data: {
        orderId: ret.orderId,
        type: 'return_confirmed',
        content: `Оформлен возврат ${ret.returnNumber}: ${ret.items.length} поз. на ${ret.totalRefundAmount.toLocaleString('ru')} ₸`,
        authorId: userId,
        authorName: userName,
      },
    });

    return confirmed;
  });

  // Replenish warehouse stock for each returned item.
  // If warehouseItemId is not set, try to resolve it via orderItemId -> variantKey -> WarehouseItem.
  // Try both old and new variantKey formats for compatibility during migration.
  // Run outside main transaction so warehouse errors don't rollback the return confirmation.
  const warehouseErrors: Array<{ itemId: string; productName: string; error: string }> = [];

  for (const item of ret.items) {
    let warehouseItemId = item.warehouseItemId;

    if (!warehouseItemId && item.orderItemId) {
      const orderItem = await prisma.chapanOrderItem.findUnique({
        where: { id: item.orderItemId },
        select: { variantKey: true, productName: true, color: true, gender: true, size: true },
      });

      if (orderItem?.variantKey) {
        // Try exact variantKey match first (new format)
        let warehouseItem = await prisma.warehouseItem.findFirst({
          where: { orgId, variantKey: orderItem.variantKey },
          select: { id: true },
        });

        // Fallback: if old variantKey format exists (contains '=' and not '|'), rebuild in new format
        if (!warehouseItem && orderItem.variantKey.includes('=') && !orderItem.variantKey.includes('|')) {
          // Old format: товар:цвет=синий:размер=44
          // Build new format: товар|цвет:синий|размер:44
          const attrs: Record<string, string> = {};
          if (orderItem.color?.trim()) attrs.color = orderItem.color.trim();
          if (orderItem.gender?.trim()) attrs.gender = orderItem.gender.trim();
          if (orderItem.size?.trim()) attrs.size = orderItem.size.trim();

          // Reconstruct with new format
          const base = orderItem.productName.trim().toLowerCase().replace(/\s+/g, ' ');
          const parts = Object.entries(attrs)
            .filter(([, v]) => v.trim())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}:${v.toLowerCase().replace(/\s+/g, ' ')}`);
          const newFormatKey = [base, ...parts].join('|');

          warehouseItem = await prisma.warehouseItem.findFirst({
            where: { orgId, variantKey: newFormatKey },
            select: { id: true },
          });
        }

        warehouseItemId = warehouseItem?.id ?? null;
      }
    }

    if (!warehouseItemId) {
      warehouseErrors.push({
        itemId: item.id,
        productName: item.productName,
        error: 'Warehouse item not found',
      });
      continue;
    }

    try {
      await addMovement(orgId, {
        itemId: warehouseItemId,
        type: 'return',
        qty: item.qty,
        sourceId: id,
        sourceType: 'chapan_return',
        reason: `Возврат ${ret.returnNumber} — ${item.productName} (${item.condition})`,
        author: userName,
      });
    } catch (err) {
      // Track warehouse errors but don't fail the confirmation
      const errorMsg = err instanceof Error ? err.message : String(err);
      warehouseErrors.push({
        itemId: item.id,
        productName: item.productName,
        error: errorMsg,
      });
      console.error(`[returns] Failed to create warehouse movement for item ${item.id}:`, err);
    }
  }

  // Return with warnings if there were warehouse errors
  return {
    ...updated,
    warnings: warehouseErrors.length > 0 ? {
      warehouseMovementsFailed: true,
      failedItems: warehouseErrors,
      message: `Warning: Stock replenishment failed for ${warehouseErrors.length} item(s). Warehouse team should be notified.`,
    } : undefined,
  };
}

export async function deleteDraft(orgId: string, id: string) {
  const ret = await prisma.chapanReturn.findFirst({
    where: { id, orgId },
    select: { id: true, status: true },
  });
  if (!ret) throw new NotFoundError('Акт возврата не найден');
  if (ret.status !== 'draft') {
    throw new AppError(400, 'Нельзя удалить подтверждённый возврат', 'CANNOT_DELETE_CONFIRMED');
  }

  await prisma.chapanReturn.delete({ where: { id } });
  return { ok: true };
}
