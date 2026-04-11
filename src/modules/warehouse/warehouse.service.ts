/**
 * warehouse.service.ts
 *
 * Core warehouse business logic:
 *  - CRUD for items, categories, locations
 *  - Movements (in/out/adjustment/write_off/return)
 *  - BOM (Bill of Materials) management
 *  - Shortage checking & auto-reservation for Chapan orders
 *  - Alert lifecycle (create → auto-resolve on stock-in)
 *  - Lot (batch) tracking
 */

import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';
import {
  createStockReservation as createCanonicalStockReservation,
  consumeStockReservationInTx as consumeCanonicalStockReservationInTx,
  releaseStockReservationInTx as releaseCanonicalStockReservationInTx,
} from './warehouse-inventory-core.service.js';

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

export interface CreateItemDto {
  name: string;
  sku?: string;
  unit?: string;
  qty?: number;
  qtyMin?: number;
  qtyMax?: number;
  costPrice?: number;
  categoryId?: string;
  locationId?: string;
  tags?: string[];
  notes?: string;
  // Variant attributes — used to compute variantKey
  color?: string;
  gender?: string;
  size?: string;
}

export interface UpdateItemDto {
  name?: string;
  sku?: string;
  unit?: string;
  qtyMin?: number;
  qtyMax?: number;
  costPrice?: number;
  categoryId?: string | null;
  locationId?: string | null;
  tags?: string[];
  notes?: string;
}

export interface AddMovementDto {
  itemId: string;
  type: 'in' | 'out' | 'adjustment' | 'write_off' | 'return';
  qty: number;
  sourceId?: string;
  sourceType?: string;
  lotId?: string;
  reason?: string;
  author: string;
}

export interface SetBOMDto {
  productKey: string;
  lines: Array<{ itemId: string; qtyPerUnit: number }>;
}

export interface ImportOpeningBalanceRow {
  name: string;
  color?: string;
  gender?: string;
  size?: string;
  qty: number;
  costPrice?: number;
}

export interface ImportOpeningBalanceResult {
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; reason: string }>;
}

export interface ShortageReport {
  orderId: string;
  status: 'ok' | 'partial' | 'blocked';
  items: Array<{
    itemId: string;
    itemName: string;
    unit: string;
    needed: number;
    available: number;
    reserved: number;
    shortage: number;
  }>;
  reservedCount: number;
  shortageCount: number;
  checkedAt: string;
}

export interface WarehouseOrderReservationSummary {
  mode: 'canonical' | 'skipped' | 'simple';
  reason?: string;
  siteId?: string;
  reservedCount: number;
  replayedCount: number;
  failedCount: number;
  skippedCount: number;
  items: Array<{
    itemId: string;
    variantKey?: string | null;
    status: 'reserved' | 'replayed' | 'failed' | 'skipped';
    reason?: string;
    reservationId?: string;
  }>;
}

export interface WarehouseOrderConsumptionSummary {
  mode: 'canonical' | 'skipped';
  reason?: string;
  siteId?: string;
  consumedCount: number;
  replayedCount: number;
  failedCount: number;
  skippedCount: number;
  items: Array<{
    itemId: string;
    variantKey?: string | null;
    status: 'consumed' | 'replayed' | 'failed' | 'skipped';
    reason?: string;
    reservationId?: string;
  }>;
}

function normalizeWarehouseName(value: string): string {
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

function readStringMapFromJson(value?: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, raw]) => [key.trim(), String(raw ?? '').trim()] as const)
      .filter(([key, raw]) => key && raw),
  );
}

function summarizeVariantAttributes(attributes: Record<string, string>) {
  return Object.entries(attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
}

// ─────────────────────────────────────────────────────────────
//  Categories & Locations
// ─────────────────────────────────────────────────────────────

export async function listCategories(orgId: string) {
  return prisma.warehouseCategory.findMany({
    where: { orgId },
    orderBy: { name: 'asc' },
  });
}

export async function createCategory(orgId: string, name: string, color?: string) {
  const exists = await prisma.warehouseCategory.findFirst({ where: { orgId, name } });
  if (exists) throw new AppError(409, 'Категория уже существует');
  return prisma.warehouseCategory.create({ data: { orgId, name, color: color ?? '#888888' } });
}

export async function deleteCategory(orgId: string, id: string) {
  await prisma.warehouseItem.updateMany({ where: { orgId, categoryId: id }, data: { categoryId: null } });
  return prisma.warehouseCategory.deleteMany({ where: { id, orgId } });
}

export async function listLocations(orgId: string) {
  return prisma.warehouseLocation.findMany({ where: { orgId }, orderBy: { name: 'asc' } });
}

export async function createLocation(orgId: string, name: string) {
  const exists = await prisma.warehouseLocation.findFirst({ where: { orgId, name } });
  if (exists) throw new AppError(409, 'Локация уже существует');
  return prisma.warehouseLocation.create({ data: { orgId, name } });
}

export async function deleteLocation(orgId: string, id: string) {
  await prisma.warehouseItem.updateMany({ where: { orgId, locationId: id }, data: { locationId: null } });
  return prisma.warehouseLocation.deleteMany({ where: { id, orgId } });
}

// ─────────────────────────────────────────────────────────────
//  Items
// ─────────────────────────────────────────────────────────────

export async function listItems(
  orgId: string,
  filters?: {
    search?: string;
    categoryId?: string;
    locationId?: string;
    lowStock?: boolean;
    page?: number;
    pageSize?: number;
  },
) {
  const page = filters?.page ?? 1;
  const pageSize = Math.min(filters?.pageSize ?? 50, 200);
  const skip = (page - 1) * pageSize;

  const where: Record<string, unknown> = { orgId };

  if (filters?.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { sku: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  if (filters?.categoryId) where.categoryId = filters.categoryId;
  if (filters?.locationId) where.locationId = filters.locationId;
  if (filters?.lowStock) {
    // qty (excluding reserved) ≤ qtyMin
    where.AND = [{ qtyMin: { gt: 0 } }];
  }

  const [total, items] = await Promise.all([
    prisma.warehouseItem.count({ where }),
    prisma.warehouseItem.findMany({
      where,
      include: { category: true, location: true },
      orderBy: { name: 'asc' },
      skip,
      take: pageSize,
    }),
  ]);

  // Post-filter lowStock (available = qty - qtyReserved)
  const result = filters?.lowStock
    ? items.filter((i) => i.qty - i.qtyReserved <= i.qtyMin)
    : items;

  return { total, page, pageSize, items: result };
}

export async function getItem(orgId: string, id: string) {
  const item = await prisma.warehouseItem.findFirst({
    where: { id, orgId },
    include: { category: true, location: true, lots: { orderBy: { receivedAt: 'desc' } } },
  });
  if (!item) throw new AppError(404, 'Позиция не найдена');
  return item;
}

export async function createItem(orgId: string, dto: CreateItemDto, authorName: string) {
  const qrCode = `KORT-WH-${nanoid(10)}`;

  // Compute variantKey when color/gender/size are provided
  const attrs: Record<string, string> = {};
  if (dto.color?.trim()) attrs.color = dto.color.trim();
  if (dto.gender?.trim()) attrs.gender = dto.gender.trim();
  if (dto.size?.trim()) attrs.size = dto.size.trim();
  const variantKey = buildWarehouseVariantKey(dto.name, attrs);
  const attributesSummary = summarizeVariantAttributes(attrs) || null;

  const item = await prisma.warehouseItem.create({
    data: {
      orgId,
      name: dto.name,
      sku: dto.sku,
      unit: dto.unit ?? 'шт',
      qty: dto.qty ?? 0,
      qtyMin: dto.qtyMin ?? 0,
      qtyMax: dto.qtyMax,
      costPrice: dto.costPrice,
      categoryId: dto.categoryId,
      locationId: dto.locationId,
      tags: dto.tags ?? [],
      notes: dto.notes,
      qrCode,
      variantKey,
      attributesJson: Object.keys(attrs).length > 0 ? attrs : undefined,
      attributesSummary,
    },
    include: { category: true, location: true },
  });

  // Record initial movement if qty > 0
  if ((dto.qty ?? 0) > 0) {
    await prisma.warehouseMovement.create({
      data: {
        orgId,
        itemId: item.id,
        type: 'in',
        qty: dto.qty!,
        qtyBefore: 0,
        qtyAfter: dto.qty!,
        reason: 'Начальный остаток',
        author: authorName,
      },
    });
  }

  return item;
}

export async function updateItem(orgId: string, id: string, dto: UpdateItemDto) {
  const item = await prisma.warehouseItem.findFirst({ where: { id, orgId } });
  if (!item) throw new AppError(404, 'Позиция не найдена');

  return prisma.warehouseItem.update({
    where: { id },
    data: {
      name: dto.name,
      sku: dto.sku,
      unit: dto.unit,
      qtyMin: dto.qtyMin,
      qtyMax: dto.qtyMax,
      costPrice: dto.costPrice,
      categoryId: dto.categoryId,
      locationId: dto.locationId,
      tags: dto.tags,
      notes: dto.notes,
    },
    include: { category: true, location: true },
  });
}

export async function deleteItem(orgId: string, id: string) {
  const item = await prisma.warehouseItem.findFirst({ where: { id, orgId } });
  if (!item) throw new AppError(404, 'Позиция не найдена');
  if (item.qtyReserved > 0) throw new AppError(400, 'Нельзя удалить позицию с активными резервами');
  await prisma.warehouseItem.delete({ where: { id } });
}

export async function bulkImportOpeningBalance(
  orgId: string,
  rows: ImportOpeningBalanceRow[],
  authorName: string,
): Promise<ImportOpeningBalanceResult> {
  const result: ImportOpeningBalanceResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const name = row.name?.trim();
      if (!name) { result.skipped++; continue; }
      const qty = Number(row.qty);
      if (isNaN(qty) || qty < 0) { result.skipped++; continue; }

      const attrs: Record<string, string> = {};
      if (row.color?.trim()) attrs.color = row.color.trim();
      if (row.gender?.trim()) attrs.gender = row.gender.trim();
      if (row.size?.trim()) attrs.size = row.size.trim();

      const variantKey = buildWarehouseVariantKey(name, attrs);
      const attributesSummary = summarizeVariantAttributes(attrs) || null;

      const existing = await prisma.warehouseItem.findFirst({ where: { orgId, variantKey } });

      if (existing) {
        if (qty === 0) { result.skipped++; continue; }
        const newQty = existing.qty + qty;
        await prisma.$transaction(async (tx) => {
          await tx.warehouseItem.update({
            where: { id: existing.id },
            data: { qty: newQty, ...(row.costPrice != null ? { costPrice: row.costPrice } : {}) },
          });
          await tx.warehouseMovement.create({
            data: {
              orgId,
              itemId: existing.id,
              type: 'in',
              qty,
              qtyBefore: existing.qty,
              qtyAfter: newQty,
              reason: 'Начальный остаток (импорт)',
              author: authorName,
              sourceType: 'opening_balance',
            },
          });
        });
        result.updated++;
      } else {
        const qrCode = `KORT-WH-${nanoid(10)}`;
        await prisma.$transaction(async (tx) => {
          const item = await tx.warehouseItem.create({
            data: {
              orgId,
              name,
              unit: 'шт',
              qty,
              qtyMin: 0,
              ...(row.costPrice != null ? { costPrice: row.costPrice } : {}),
              variantKey,
              attributesJson: Object.keys(attrs).length > 0 ? attrs : undefined,
              attributesSummary,
              qrCode,
              tags: [],
            },
          });
          if (qty > 0) {
            await tx.warehouseMovement.create({
              data: {
                orgId,
                itemId: item.id,
                type: 'in',
                qty,
                qtyBefore: 0,
                qtyAfter: qty,
                reason: 'Начальный остаток (импорт)',
                author: authorName,
                sourceType: 'opening_balance',
              },
            });
          }
        });
        result.created++;
      }
    } catch (err) {
      result.errors.push({
        row: i + 1,
        reason: err instanceof Error ? err.message : 'Неизвестная ошибка',
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  Movements
// ─────────────────────────────────────────────────────────────

export async function addMovement(orgId: string, dto: AddMovementDto): Promise<void> {
  const item = await prisma.warehouseItem.findFirst({ where: { id: dto.itemId, orgId } });
  if (!item) throw new AppError(404, 'Позиция не найдена');

  const isIncoming = ['in', 'return', 'adjustment'].includes(dto.type) && dto.qty > 0;
  const isOutgoing = ['out', 'write_off'].includes(dto.type) || dto.qty < 0;
  const isAdjustment = dto.type === 'adjustment';

  const qty = Math.abs(dto.qty);
  const available = item.qty - item.qtyReserved;

  if (isOutgoing && !isAdjustment && available < qty) {
    throw new AppError(400, `Недостаточно свободного остатка: есть ${available} ${item.unit}`);
  }

  // P3 guard: adjustment can bypass reserved-stock check but cannot push total below 0
  if (isAdjustment && dto.qty < 0 && item.qty - qty < 0) {
    throw new AppError(400, `Корректировка не может снизить остаток ниже нуля: текущий остаток ${item.qty} ${item.unit}`);
  }

  const delta = isIncoming ? qty : -qty;
  const qtyAfter = item.qty + delta;

  await prisma.$transaction(async (tx) => {
    await tx.warehouseItem.update({
      where: { id: item.id },
      data: { qty: qtyAfter },
    });

    await tx.warehouseMovement.create({
      data: {
        orgId,
        itemId: item.id,
        type: dto.type,
        qty: delta,
        qtyBefore: item.qty,
        qtyAfter,
        sourceId: dto.sourceId,
        sourceType: dto.sourceType,
        lotId: dto.lotId,
        reason: dto.reason,
        author: dto.author,
      },
    });

    // Check and auto-resolve low stock alert if now above threshold
    if (isIncoming) {
      await checkLowStockAlerts(tx, orgId, item.id, qtyAfter, item.qtyReserved, item.qtyMin);
    }

    // Create low stock alert if now below threshold
    if (isOutgoing && item.qtyMin > 0 && qtyAfter <= item.qtyMin) {
      const existing = await tx.warehouseAlert.findFirst({
        where: { orgId, itemId: item.id, type: 'low_stock', status: 'open' },
      });
      if (!existing) {
        await tx.warehouseAlert.create({
          data: {
            orgId,
            itemId: item.id,
            type: 'low_stock',
            qtyHave: qtyAfter,
            qtyNeed: item.qtyMin,
          },
        });
      }
    }
  });

  // After stock-in: check if any shortage alerts can be resolved
  if (isIncoming) {
    await tryResolveShortageAlerts(orgId, item.id);
  }
}

async function checkLowStockAlerts(
  tx: Prisma.TransactionClient,
  orgId: string,
  itemId: string,
  newQty: number,
  reserved: number,
  qtyMin: number,
) {
  const available = newQty - reserved;
  if (available > qtyMin) {
    await tx.warehouseAlert.updateMany({
      where: { orgId, itemId, type: 'low_stock', status: 'open' },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
  }
}

// After a stock-in movement, try to auto-unblock production tasks
async function tryResolveShortageAlerts(orgId: string, itemId: string) {
  const openAlerts = await prisma.warehouseAlert.findMany({
    where: { orgId, itemId, type: 'shortage_for_order', status: 'open' },
  });

  for (const alert of openAlerts) {
    if (!alert.sourceId) continue;
    // Re-run BOM check for the order — if now OK, resolve alert + unblock tasks
    try {
      const report = await checkOrderBOM(orgId, alert.sourceId, false);
      if (report.status === 'ok') {
        await prisma.warehouseAlert.update({
          where: { id: alert.id },
          data: { status: 'resolved', resolvedAt: new Date() },
        });
        // Unblock production tasks for this chapan order
        await prisma.chapanProductionTask.updateMany({
          where: { orderId: alert.sourceId, isBlocked: true },
          data: { isBlocked: false, blockReason: null },
        });
      }
    } catch {
      // order might not exist anymore — just continue
    }
  }
}

export async function listMovements(
  orgId: string,
  filters?: { itemId?: string; type?: string; page?: number; pageSize?: number },
) {
  const page = filters?.page ?? 1;
  const pageSize = Math.min(filters?.pageSize ?? 50, 200);

  const where: Record<string, unknown> = { orgId };
  if (filters?.itemId) where.itemId = filters.itemId;
  if (filters?.type) where.type = filters.type;

  const [total, movements] = await Promise.all([
    prisma.warehouseMovement.count({ where }),
    prisma.warehouseMovement.findMany({
      where,
      include: { item: { select: { name: true, unit: true, sku: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, movements };
}

// ─────────────────────────────────────────────────────────────
//  BOM (Bill of Materials)
// ─────────────────────────────────────────────────────────────

export async function getBOM(orgId: string, productKey: string) {
  return prisma.warehouseBOMLine.findMany({
    where: { orgId, productKey },
    include: { item: { select: { id: true, name: true, unit: true, sku: true, qty: true, qtyReserved: true } } },
  });
}

export async function setBOM(orgId: string, dto: SetBOMDto) {
  return prisma.$transaction(async (tx) => {
    // Delete existing lines for this product
    await tx.warehouseBOMLine.deleteMany({ where: { orgId, productKey: dto.productKey } });

    if (dto.lines.length === 0) return [];

    // Verify all items exist
    for (const line of dto.lines) {
      const item = await tx.warehouseItem.findFirst({ where: { id: line.itemId, orgId } });
      if (!item) throw new AppError(404, `Позиция ${line.itemId} не найдена`);
    }

    return tx.warehouseBOMLine.createMany({
      data: dto.lines.map((l) => ({
        orgId,
        productKey: dto.productKey,
        itemId: l.itemId,
        qtyPerUnit: l.qtyPerUnit,
      })),
    });
  });
}

export async function listBOMProducts(orgId: string) {
  const groups = await prisma.warehouseBOMLine.groupBy({
    by: ['productKey'],
    where: { orgId },
    _count: { itemId: true },
  });
  return groups.map((g) => ({ productKey: g.productKey, lineCount: g._count.itemId }));
}

async function getSingleActiveWarehouseSite(orgId: string) {
  const sites = await prisma.warehouseSite.findMany({
    where: { orgId, status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true, name: true },
    take: 2,
  });

  if (sites.length !== 1) {
    return null;
  }

  return sites[0];
}

type WarehouseReservationOrderItem = {
  id: string;
  productName: string;
  quantity: number;
  variantKey?: string | null;
  attributesJson?: Prisma.JsonValue | null;
  attributesSummary?: string | null;
};

async function findOrCreateCanonicalVariantForOrderItem(
  orgId: string,
  orderItem: WarehouseReservationOrderItem,
): Promise<{ variantId?: string; variantKey?: string; reason?: string }> {
  const product = await prisma.warehouseProductCatalog.findFirst({
    where: {
      orgId,
      normalizedName: normalizeWarehouseName(orderItem.productName),
      isActive: true,
    },
    include: {
      fieldLinks: {
        include: { definition: true },
      },
    },
  });

  if (!product) {
    return { reason: 'product_catalog_not_found' };
  }

  const attributes = readStringMapFromJson(orderItem.attributesJson);
  const availabilityFields = new Set(
    product.fieldLinks
      .filter((link) => link.definition.affectsAvailability)
      .map((link) => link.definition.code),
  );
  const attributesForKey =
    availabilityFields.size > 0
      ? Object.fromEntries(Object.entries(attributes).filter(([key]) => availabilityFields.has(key)))
      : attributes;

  const variantKey =
    orderItem.variantKey?.trim() ||
    buildWarehouseVariantKey(product.name ?? orderItem.productName, attributesForKey);

  if (!variantKey) {
    return { reason: 'variant_key_missing' };
  }

  let variant = await prisma.warehouseVariant.findFirst({
    where: {
      orgId,
      productCatalogId: product.id,
      variantKey,
    },
    select: { id: true, variantKey: true },
  });

  if (!variant) {
    try {
      variant = await prisma.warehouseVariant.create({
        data: {
          orgId,
          productCatalogId: product.id,
          variantKey,
          attributesJson: Object.keys(attributes).length > 0 ? attributes : undefined,
          attributesSummary: orderItem.attributesSummary?.trim() || summarizeVariantAttributes(attributes) || null,
        },
        select: { id: true, variantKey: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }

      variant = await prisma.warehouseVariant.findFirst({
        where: {
          orgId,
          productCatalogId: product.id,
          variantKey,
        },
        select: { id: true, variantKey: true },
      });
    }
  }

  if (!variant) {
    return { reason: 'variant_resolution_failed' };
  }

  return {
    variantId: variant.id,
    variantKey: variant.variantKey,
  };
}

// ── Simple (non-canonical) reservation fallback (P3) ──────────────────────────

async function reserveSimpleOrderItems(
  orgId: string,
  orderId: string,
  warehouseItems: Array<{
    id: string;
    productName: string;
    color?: string | null;
    gender?: string | null;
    size?: string | null;
    quantity: number;
    variantKey?: string | null;
  }>,
): Promise<WarehouseOrderReservationSummary> {
  const summary: WarehouseOrderReservationSummary = {
    mode: 'simple',
    reservedCount: 0,
    replayedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    items: [],
  };

  for (const orderItem of warehouseItems) {
    const name = orderItem.productName?.trim();
    if (!name) { summary.skippedCount++; continue; }

    // Build variantKey (same logic as checkVariantAvailability)
    const attrs: Record<string, string> = {};
    if (orderItem.color?.trim()) attrs.color = orderItem.color.trim();
    if (orderItem.gender?.trim()) attrs.gender = orderItem.gender.trim();
    if (orderItem.size?.trim()) attrs.size = orderItem.size.trim();
    const variantKey = buildWarehouseVariantKey(name, attrs);

    const warehouseItem = await prisma.warehouseItem.findFirst({
      where: { orgId, variantKey },
      select: { id: true, qty: true, qtyReserved: true },
    }) ?? await prisma.warehouseItem.findFirst({
      where: { orgId, name: { contains: name, mode: 'insensitive' } },
      select: { id: true, qty: true, qtyReserved: true },
    });

    if (!warehouseItem) {
      summary.skippedCount++;
      summary.items.push({ itemId: orderItem.id, variantKey, status: 'skipped', reason: 'item_not_found' });
      continue;
    }

    // Idempotency: check existing reservation for this order + item
    const existing = await prisma.warehouseReservation.findFirst({
      where: { orgId, sourceId: orderId, itemId: warehouseItem.id, status: 'active' },
    });
    if (existing) {
      summary.replayedCount++;
      summary.items.push({ itemId: orderItem.id, variantKey, status: 'replayed' });
      continue;
    }

    const available = warehouseItem.qty - warehouseItem.qtyReserved;
    const needed = orderItem.quantity;
    if (available < needed) {
      summary.failedCount++;
      summary.items.push({ itemId: orderItem.id, variantKey, status: 'failed', reason: 'insufficient_stock' });
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.warehouseReservation.create({
        data: { orgId, itemId: warehouseItem.id, qty: needed, sourceId: orderId, sourceType: 'chapan_order', status: 'active' },
      });
      await tx.warehouseItem.update({
        where: { id: warehouseItem.id },
        data: { qtyReserved: { increment: needed } },
      });
    });

    summary.reservedCount++;
    summary.items.push({ itemId: orderItem.id, variantKey, status: 'reserved' });
  }

  return summary;
}

export async function reserveOrderWarehouseItems(
  orgId: string,
  orderId: string,
  actorName = 'system',
): Promise<WarehouseOrderReservationSummary> {
  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: { items: true },
  });
  if (!order) {
    throw new AppError(404, 'Заказ не найден');
  }

  const warehouseItems = order.items.filter((item) => item.fulfillmentMode === 'warehouse');
  if (warehouseItems.length === 0) {
    return {
      mode: 'skipped',
      reason: 'no_warehouse_items',
      reservedCount: 0,
      replayedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      items: [],
    };
  }

  const site = await getSingleActiveWarehouseSite(orgId);
  if (!site) {
    // P3: No canonical WMS site — fall back to simple WarehouseItem.qtyReserved reservation
    return reserveSimpleOrderItems(orgId, orderId, warehouseItems);
  }

  const summary: WarehouseOrderReservationSummary = {
    mode: 'canonical',
    siteId: site.id,
    reservedCount: 0,
    replayedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    items: [],
  };

  for (const item of warehouseItems) {
    const resolved = await findOrCreateCanonicalVariantForOrderItem(orgId, item);
    if (!resolved.variantId || !resolved.variantKey) {
      summary.skippedCount += 1;
      summary.items.push({
        itemId: item.id,
        variantKey: item.variantKey,
        status: 'skipped',
        reason: resolved.reason ?? 'variant_resolution_failed',
      });
      continue;
    }

    try {
      const result = await createCanonicalStockReservation(orgId, {
        warehouseSiteId: site.id,
        variantId: resolved.variantId,
        qty: item.quantity,
        sourceType: 'chapan_order_item',
        sourceId: order.id,
        sourceLineId: item.id,
        idempotencyKey: `chapan-order-item:${item.id}:reserve:v1`,
        actorName,
        reason: `Canonical reservation for order ${order.orderNumber}`,
      });

      if (result.replayed) {
        summary.replayedCount += 1;
        summary.items.push({
          itemId: item.id,
          variantKey: resolved.variantKey,
          status: 'replayed',
          reservationId: result.reservation?.id,
        });
      } else {
        summary.reservedCount += 1;
        summary.items.push({
          itemId: item.id,
          variantKey: resolved.variantKey,
          status: 'reserved',
          reservationId: result.reservation?.id,
        });
      }
    } catch (error) {
      summary.failedCount += 1;
      summary.items.push({
        itemId: item.id,
        variantKey: resolved.variantKey,
        status: 'failed',
        reason: error instanceof Error ? error.message : 'reservation_failed',
      });
    }
  }

  return summary;
}

export async function consumeOrderWarehouseReservations(
  orgId: string,
  orderId: string,
  actorName = 'system',
): Promise<WarehouseOrderConsumptionSummary> {
  return prisma.$transaction((tx) => consumeOrderWarehouseReservationsTx(tx, orgId, orderId, actorName));
}

export async function consumeOrderWarehouseReservationsTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  orderId: string,
  actorName = 'system',
): Promise<WarehouseOrderConsumptionSummary> {
  const reservations = await tx.warehouseStockReservation.findMany({
    where: {
      orgId,
      sourceType: 'chapan_order_item',
      sourceId: orderId,
      status: { in: ['active', 'consumed'] },
    },
    include: {
      variant: {
        select: {
          variantKey: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (reservations.length === 0) {
    return {
      mode: 'skipped',
      reason: 'no_canonical_reservations',
      consumedCount: 0,
      replayedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      items: [],
    };
  }

  const summary: WarehouseOrderConsumptionSummary = {
    mode: 'canonical',
    siteId: reservations[0]?.warehouseSiteId,
    consumedCount: 0,
    replayedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    items: [],
  };

  for (const reservation of reservations) {
    try {
      const result = await consumeCanonicalStockReservationInTx(
        tx,
        orgId,
        reservation.id,
        actorName,
        `Canonical fulfillment consume for order ${orderId}`,
      );

      if (result.replayed) {
        summary.replayedCount += 1;
        summary.items.push({
          itemId: reservation.sourceLineId ?? reservation.id,
          variantKey: reservation.variant.variantKey,
          status: 'replayed',
          reservationId: reservation.id,
        });
      } else {
        summary.consumedCount += 1;
        summary.items.push({
          itemId: reservation.sourceLineId ?? reservation.id,
          variantKey: reservation.variant.variantKey,
          status: 'consumed',
          reservationId: reservation.id,
        });
      }
    } catch (error) {
      summary.failedCount += 1;
      summary.items.push({
        itemId: reservation.sourceLineId ?? reservation.id,
        variantKey: reservation.variant.variantKey,
        status: 'failed',
        reservationId: reservation.id,
        reason: error instanceof Error ? error.message : 'consume_failed',
      });
    }
  }

  return summary;
}

// ─────────────────────────────────────────────────────────────
//  Order BOM check & reservation (Chapan integration)
// ─────────────────────────────────────────────────────────────

/**
 * Checks if warehouse has enough stock for a Chapan order based on BOM.
 * If reserve=true, creates WarehouseReservation records for sufficient items.
 * Blocks production tasks for items with shortages.
 */
export async function checkOrderBOM(
  orgId: string,
  chapanOrderId: string,
  reserve = true,
): Promise<ShortageReport> {
  const order = await prisma.chapanOrder.findFirst({
    where: { id: chapanOrderId, orgId },
    include: { items: true },
  });
  if (!order) throw new AppError(404, 'Заказ не найден');

  const reportItems: ShortageReport['items'] = [];
  let shortageCount = 0;
  let reservedCount = 0;

  // Aggregate required quantities per warehouse item across all order items
  const neededMap = new Map<string, { item: { id: string; name: string; unit: string; qty: number; qtyReserved: number }; needed: number }>();

  for (const orderItem of order.items) {
    const bomLines = await prisma.warehouseBOMLine.findMany({
      where: { orgId, productKey: orderItem.productName },
      include: { item: { select: { id: true, name: true, unit: true, qty: true, qtyReserved: true } } },
    });

    for (const line of bomLines) {
      const totalNeeded = line.qtyPerUnit * orderItem.quantity;
      const existing = neededMap.get(line.itemId);
      if (existing) {
        existing.needed += totalNeeded;
      } else {
        neededMap.set(line.itemId, { item: line.item, needed: totalNeeded });
      }
    }
  }

  // Check each needed item
  for (const [itemId, { item, needed }] of neededMap) {
    // Get current item state (fresh from DB)
    const freshItem = await prisma.warehouseItem.findUnique({ where: { id: itemId } });
    if (!freshItem) continue;

    // Check existing reservation for this order/item
    const existingRes = await prisma.warehouseReservation.findFirst({
      where: { orgId, itemId, sourceId: chapanOrderId, status: 'active' },
    });
    const alreadyReserved = existingRes?.qty ?? 0;

    const available = freshItem.qty - freshItem.qtyReserved + alreadyReserved;
    const shortage = Math.max(0, needed - available);

    reportItems.push({
      itemId,
      itemName: item.name,
      unit: item.unit,
      needed,
      available,
      reserved: alreadyReserved,
      shortage,
    });

    if (shortage > 0) {
      shortageCount++;
      // Create/update shortage alert
      await upsertShortageAlert(orgId, itemId, chapanOrderId, needed, available);
    } else {
      reservedCount++;
      // Create reservation if requested and not already reserved
      if (reserve && !existingRes) {
        await prisma.$transaction(async (tx) => {
          await tx.warehouseReservation.create({
            data: {
              orgId,
              itemId,
              qty: needed,
              sourceId: chapanOrderId,
              sourceType: 'chapan_order',
              status: 'active',
            },
          });
          await tx.warehouseItem.update({
            where: { id: itemId },
            data: { qtyReserved: { increment: needed } },
          });
          await tx.warehouseMovement.create({
            data: {
              orgId,
              itemId,
              type: 'reserved',
              qty: -needed,
              qtyBefore: freshItem.qty,
              qtyAfter: freshItem.qty,
              sourceId: chapanOrderId,
              sourceType: 'chapan_order',
              reason: `Резерв под заказ ${order.orderNumber}`,
              author: 'system',
            },
          });
        });
      }
    }
  }

  // Determine overall status
  const status: ShortageReport['status'] =
    shortageCount === 0 ? 'ok' : shortageCount === neededMap.size ? 'blocked' : 'partial';

  // If there are shortages, block production tasks for this order
  if (shortageCount > 0) {
    const shortageNames = reportItems
      .filter((i) => i.shortage > 0)
      .map((i) => `${i.itemName} (нужно ещё ${i.shortage} ${i.unit})`)
      .join('; ');

    await prisma.chapanProductionTask.updateMany({
      where: { orderId: chapanOrderId },
      data: { isBlocked: true, blockReason: `Нехватка материалов: ${shortageNames}` },
    });
  } else if (neededMap.size > 0) {
    // All good — unblock any previously blocked tasks
    await prisma.chapanProductionTask.updateMany({
      where: { orderId: chapanOrderId, isBlocked: true },
      data: { isBlocked: false, blockReason: null },
    });
  }

  return {
    orderId: chapanOrderId,
    status,
    items: reportItems,
    reservedCount,
    shortageCount,
    checkedAt: new Date().toISOString(),
  };
}

async function upsertShortageAlert(
  orgId: string,
  itemId: string,
  orderId: string,
  qtyNeed: number,
  qtyHave: number,
) {
  const existing = await prisma.warehouseAlert.findFirst({
    where: { orgId, itemId, type: 'shortage_for_order', sourceId: orderId, status: 'open' },
  });
  if (existing) {
    await prisma.warehouseAlert.update({
      where: { id: existing.id },
      data: { qtyNeed, qtyHave },
    });
  } else {
    await prisma.warehouseAlert.create({
      data: { orgId, itemId, type: 'shortage_for_order', sourceId: orderId, qtyNeed, qtyHave },
    });
  }
}

/**
 * Release all reservations for a cancelled/completed order.
 */
export async function releaseOrderReservations(orgId: string, sourceId: string) {
  return prisma.$transaction((tx) => releaseOrderReservationsTx(tx, orgId, sourceId));
}

/**
 * P3: Consume simple WarehouseReservations on shipment.
 * Creates an 'out' movement and decrements WarehouseItem.qty + qtyReserved.
 * Used when canonical WMS is not set up (simple qtyReserved path).
 */
export async function consumeSimpleOrderReservations(
  orgId: string,
  orderId: string,
  authorName: string,
): Promise<void> {
  const reservations = await prisma.warehouseReservation.findMany({
    where: { orgId, sourceId: orderId, sourceType: 'chapan_order', status: 'active' },
    include: { item: { select: { id: true, qty: true, qtyReserved: true } } },
  });
  if (reservations.length === 0) return;

  await prisma.$transaction(async (tx) => {
    for (const res of reservations) {
      const item = res.item;
      const outQty = Math.min(res.qty, item.qty); // never below 0
      const newQty = item.qty - outQty;
      const newReserved = Math.max(0, item.qtyReserved - res.qty);

      await tx.warehouseItem.update({
        where: { id: item.id },
        data: { qty: newQty, qtyReserved: newReserved },
      });
      await tx.warehouseMovement.create({
        data: {
          orgId,
          itemId: item.id,
          type: 'out',
          qty: -outQty,
          qtyBefore: item.qty,
          qtyAfter: newQty,
          sourceId: orderId,
          sourceType: 'chapan_order_shipment',
          reason: 'Отгрузка клиенту',
          author: authorName,
        },
      });
      await tx.warehouseReservation.update({
        where: { id: res.id },
        data: { status: 'fulfilled' },
      });
    }
  });
}

export async function releaseOrderReservationsTx(
  tx: Prisma.TransactionClient,
  orgId: string,
  sourceId: string,
  actorName = 'system',
) {
  const canonicalReservations = await tx.warehouseStockReservation.findMany({
    where: {
      orgId,
      sourceId,
      sourceType: 'chapan_order_item',
    },
    select: {
      id: true,
      compatibilityReservationId: true,
    },
  });

  let releasedCanonicalCount = 0;

  for (const reservation of canonicalReservations) {
    const result = await releaseCanonicalStockReservationInTx(
      tx,
      orgId,
      reservation.id,
      actorName,
      `Release reservations for order ${sourceId}`,
    );

    if (!result.replayed) {
      releasedCanonicalCount += 1;
    }
  }

  const compatibilityReservationIds = canonicalReservations
    .map((reservation) => reservation.compatibilityReservationId)
    .filter((value): value is string => Boolean(value));

  const reservations = await tx.warehouseReservation.findMany({
    where: {
      orgId,
      sourceId,
      status: 'active',
      ...(compatibilityReservationIds.length > 0 ? { id: { notIn: compatibilityReservationIds } } : {}),
    },
  });

  let releasedCompatibilityCount = 0;

  for (const reservation of reservations) {
    await tx.warehouseReservation.update({
      where: { id: reservation.id },
      data: { status: 'released' },
    });
    await tx.warehouseItem.update({
      where: { id: reservation.itemId },
      data: { qtyReserved: { decrement: reservation.qty } },
    });
    releasedCompatibilityCount += 1;
  }

  await tx.warehouseAlert.updateMany({
    where: { orgId, sourceId, type: 'shortage_for_order', status: 'open' },
    data: { status: 'resolved', resolvedAt: new Date() },
  });

  return {
    releasedCanonicalCount,
    releasedCompatibilityCount,
  };
}

// ─────────────────────────────────────────────────────────────
//  Alerts
// ─────────────────────────────────────────────────────────────

export async function listAlerts(orgId: string, status?: string) {
  return prisma.warehouseAlert.findMany({
    where: { orgId, status: status ?? 'open' },
    include: { item: { select: { name: true, unit: true, sku: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function resolveAlert(orgId: string, id: string) {
  const alert = await prisma.warehouseAlert.findFirst({ where: { id, orgId } });
  if (!alert) throw new AppError(404, 'Алерт не найден');
  return prisma.warehouseAlert.update({
    where: { id },
    data: { status: 'resolved', resolvedAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────
//  Lots
// ─────────────────────────────────────────────────────────────

export async function listLots(orgId: string, itemId?: string) {
  return prisma.warehouseLot.findMany({
    where: { orgId, ...(itemId ? { itemId } : {}) },
    include: { item: { select: { name: true, unit: true } } },
    orderBy: { receivedAt: 'desc' },
  });
}

export async function createLot(
  orgId: string,
  data: { itemId: string; lotNumber: string; qty: number; supplier?: string; expiresAt?: string; notes?: string },
  author: string,
) {
  const item = await prisma.warehouseItem.findFirst({ where: { id: data.itemId, orgId } });
  if (!item) throw new AppError(404, 'Позиция не найдена');

  const lot = await prisma.warehouseLot.create({
    data: {
      orgId,
      itemId: data.itemId,
      lotNumber: data.lotNumber,
      qty: data.qty,
      supplier: data.supplier,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
      notes: data.notes,
    },
  });

  // Auto-create incoming movement for this lot
  await addMovement(orgId, {
    itemId: data.itemId,
    type: 'in',
    qty: data.qty,
    lotId: lot.id,
    reason: `Партия ${data.lotNumber}${data.supplier ? ` от ${data.supplier}` : ''}`,
    author,
  });

  return lot;
}

// ─────────────────────────────────────────────────────────────
//  Finished-goods availability check (Chapan integration)
// ─────────────────────────────────────────────────────────────

/**
 * Checks whether finished products (by name) are available in warehouse.
 * Used by Chapan to skip production for in-stock items.
 */
export async function checkProductNamesAvailability(
  orgId: string,
  productNames: string[],
): Promise<Record<string, { available: boolean; qty: number; itemName: string | null }>> {
  const unique = [...new Set(productNames.filter(Boolean))];
  const result: Record<string, { available: boolean; qty: number; itemName: string | null }> = {};

  for (const name of unique) {
    const trimmedName = name.trim();
    const normalizedName = normalizeWarehouseName(trimmedName);

    const catalogProducts = await prisma.warehouseProductCatalog.findMany({
      where: {
        orgId,
        OR: [
          { normalizedName },
          { name: { contains: trimmedName, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true },
      take: 10,
    });

    if (catalogProducts.length > 0) {
      const canonicalVariants = await prisma.warehouseVariant.findMany({
        where: {
          orgId,
          productCatalogId: {
            in: catalogProducts.map((product) => product.id),
          },
        },
        select: { id: true },
      });

      if (canonicalVariants.length > 0) {
        const canonicalBalances = await prisma.warehouseStockBalance.aggregate({
          where: {
            orgId,
            variantId: {
              in: canonicalVariants.map((variant) => variant.id),
            },
            stockStatus: 'available',
          },
          _sum: {
            qtyAvailable: true,
          },
        });

        const totalAvailable = canonicalBalances._sum.qtyAvailable ?? 0;
        result[name] = {
          available: totalAvailable > 0,
          qty: totalAvailable,
          itemName: catalogProducts[0]?.name ?? trimmedName,
        };
        continue;
      }
    }

    const items = await prisma.warehouseItem.findMany({
      where: { orgId, name: { contains: trimmedName, mode: 'insensitive' } },
      select: { id: true, name: true, qty: true, qtyReserved: true },
    });
    const totalAvailable = items.reduce((sum, i) => sum + Math.max(0, i.qty - i.qtyReserved), 0);
    result[name] = {
      available: totalAvailable > 0,
      qty: totalAvailable,
      itemName: items[0]?.name ?? null,
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  Variant-level availability check (P2)
// ─────────────────────────────────────────────────────────────

export type VariantAvailabilityStatus = 'ok' | 'low' | 'none';

export interface VariantAvailabilityResult {
  qty: number;
  available: number;
  status: VariantAvailabilityStatus;
  itemName: string | null;
}

export async function checkVariantAvailability(
  orgId: string,
  variants: Array<{ name: string; color?: string; size?: string; gender?: string }>,
): Promise<Record<string, VariantAvailabilityResult>> {
  const result: Record<string, VariantAvailabilityResult> = {};

  for (const v of variants) {
    const name = v.name?.trim();
    if (!name) continue;

    const attrs: Record<string, string> = {};
    if (v.color?.trim()) attrs.color = v.color.trim();
    if (v.gender?.trim()) attrs.gender = v.gender.trim();
    if (v.size?.trim()) attrs.size = v.size.trim();

    const variantKey = buildWarehouseVariantKey(name, attrs);
    const hasAttributes = Object.keys(attrs).length > 0;

    // Exact variantKey match first
    let item = await prisma.warehouseItem.findFirst({
      where: { orgId, variantKey },
      select: { name: true, qty: true, qtyReserved: true, qtyMin: true },
    });

    // Fall back to name-only match when no attributes given
    if (!item && !hasAttributes) {
      item = await prisma.warehouseItem.findFirst({
        where: { orgId, name: { contains: name, mode: 'insensitive' } },
        select: { name: true, qty: true, qtyReserved: true, qtyMin: true },
      });
    }

    if (!item) {
      result[variantKey] = { qty: 0, available: 0, status: 'none', itemName: null };
      continue;
    }

    const available = Math.max(0, item.qty - item.qtyReserved);
    const qtyMin = item.qtyMin ?? 0;
    const status: VariantAvailabilityStatus =
      available === 0 ? 'none' : available <= qtyMin ? 'low' : 'ok';

    result[variantKey] = { qty: item.qty, available, status, itemName: item.name };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
//  Dashboard summary
// ─────────────────────────────────────────────────────────────

export async function getWarehouseSummary(orgId: string) {
  const [totalItems, openAlerts, , totalMovementsToday] = await Promise.all([
    prisma.warehouseItem.count({ where: { orgId } }),
    prisma.warehouseAlert.count({ where: { orgId, status: 'open' } }),
    prisma.warehouseItem.count({
      where: { orgId, qtyMin: { gt: 0 } },
    }),
    prisma.warehouseMovement.count({
      where: {
        orgId,
        createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
    }),
  ]);

  // Items actually low (available ≤ min)
  const allItemsWithMin = await prisma.warehouseItem.findMany({
    where: { orgId, qtyMin: { gt: 0 } },
    select: { qty: true, qtyReserved: true, qtyMin: true },
  });
  const actualLowStock = allItemsWithMin.filter((i) => i.qty - i.qtyReserved <= i.qtyMin).length;

  // Top 3 low items for tile preview
  const allItems = await prisma.warehouseItem.findMany({
    where: { orgId },
    select: { id: true, name: true, unit: true, qty: true, qtyReserved: true, qtyMin: true },
    orderBy: { name: 'asc' },
    take: 50,
  });

  const lowItems = allItems
    .filter((i) => i.qtyMin > 0 && i.qty - i.qtyReserved <= i.qtyMin)
    .slice(0, 3);

  return {
    totalItems,
    openAlerts,
    lowStockCount: actualLowStock,
    totalMovementsToday,
    lowItems,
  };
}
