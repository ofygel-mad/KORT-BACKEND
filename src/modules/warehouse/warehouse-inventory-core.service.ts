import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

type Tx = Prisma.TransactionClient | PrismaClient;
export type WarehouseInventoryTx = Prisma.TransactionClient;

export interface UpsertWarehouseVariantDto {
  productCatalogId: string;
  variantKey?: string;
  attributesJson?: Record<string, string>;
  attributesSummary?: string | null;
}

export interface PostStockReceiptDto {
  warehouseSiteId: string;
  variantId: string;
  toBinId: string;
  qty: number;
  stockStatus?: string;
  sourceType: string;
  sourceId?: string;
  sourceLineId?: string;
  idempotencyKey: string;
  actorUserId?: string;
  actorName?: string;
  reason?: string;
}

export interface PostStockTransferDto {
  warehouseSiteId: string;
  variantId: string;
  fromBinId: string;
  toBinId: string;
  qty: number;
  stockStatusFrom?: string;
  stockStatusTo?: string;
  sourceType: string;
  sourceId?: string;
  sourceLineId?: string;
  idempotencyKey: string;
  actorUserId?: string;
  actorName?: string;
  reason?: string;
}

export interface CreateStockReservationDto {
  warehouseSiteId: string;
  variantId: string;
  qty: number;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string;
  idempotencyKey: string;
  actorName?: string;
  reason?: string;
}

export interface ConsumeStockReservationResult {
  replayed: boolean;
  reservation: Prisma.WarehouseStockReservationGetPayload<{
    include: {
      allocations: true;
    };
  }> | null;
  snapshot?: Awaited<ReturnType<typeof getInventorySnapshot>>;
  compatibilityItem?: {
    id: string;
    qty: number;
    qtyReserved: number;
  };
  ledgerEvents?: Array<{
    id: string;
    fromBinId: string | null;
    qtyDelta: number;
  }>;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildVariantKey(productName: string, attributes: Record<string, string>): string {
  const base = normalizeName(productName);
  const parts = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${normalizeName(value)}`);
  return [base, ...parts].join('|');
}

function ensurePositiveNumber(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(400, `${label} должно быть больше нуля`, 'VALIDATION');
  }
}

function normalizeStringMap(input?: Record<string, string>) {
  const entries = Object.entries(input ?? {})
    .map(([key, value]) => [key.trim(), String(value ?? '').trim()] as const)
    .filter(([key, value]) => key && value);
  return Object.fromEntries(entries);
}

function buildAttributesSummary(attributes: Record<string, string>) {
  const parts = Object.entries(attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function buildCompatibilityItemName(productName: string, attributesSummary?: string | null) {
  const summary = attributesSummary?.trim();
  return summary ? `${productName} / ${summary}` : productName;
}

async function createOutboxRecord(tx: Tx, input: {
  orgId: string;
  warehouseSiteId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await tx.warehouseOutbox.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

async function getVariantOrThrow(orgId: string, variantId: string) {
  const variant = await prisma.warehouseVariant.findFirst({
    where: { id: variantId, orgId },
    include: {
      productCatalog: {
        include: {
          fieldLinks: {
            include: { definition: true },
          },
        },
      },
    },
  });
  if (!variant) {
    throw new AppError(404, 'Вариант склада не найден', 'NOT_FOUND');
  }
  return variant;
}

async function ensureSiteAndBin(orgId: string, siteId: string, binId: string) {
  const bin = await prisma.warehouseBin.findFirst({
    where: { id: binId, orgId, warehouseSiteId: siteId },
    include: {
      zone: {
        select: { id: true, code: true, name: true },
      },
    },
  });
  if (!bin) {
    throw new AppError(404, 'Ячейка не найдена в указанном складе', 'NOT_FOUND');
  }
  return bin;
}

async function ensureCompatibilityItem(
  tx: Tx,
  orgId: string,
  variant: {
    productCatalogId: string;
    variantKey: string;
    attributesJson: Prisma.JsonValue | null;
    attributesSummary: string | null;
    productCatalog: { name: string };
  },
) {
  const existing = await tx.warehouseItem.findFirst({
    where: {
      orgId,
      productCatalogId: variant.productCatalogId,
      variantKey: variant.variantKey,
    },
  });

  const name = buildCompatibilityItemName(variant.productCatalog.name, variant.attributesSummary);
  if (existing) {
    return tx.warehouseItem.update({
      where: { id: existing.id },
      data: {
        name,
        productCatalogId: variant.productCatalogId,
        variantKey: variant.variantKey,
        attributesJson: variant.attributesJson as Prisma.InputJsonValue | undefined,
        attributesSummary: variant.attributesSummary,
      },
    });
  }

  return tx.warehouseItem.create({
    data: {
      orgId,
      name,
      unit: 'шт',
      qty: 0,
      qtyMin: 0,
      productCatalogId: variant.productCatalogId,
      variantKey: variant.variantKey,
      attributesJson: (variant.attributesJson ?? undefined) as Prisma.InputJsonValue | undefined,
      attributesSummary: variant.attributesSummary,
    },
  });
}

async function upsertBalance(
  tx: Tx,
  input: {
    orgId: string;
    warehouseSiteId: string;
    variantId: string;
    binId: string;
    stockStatus: string;
    onHandDelta: number;
    reservedDelta?: number;
    availableDelta?: number;
  },
) {
  const existing = await tx.warehouseStockBalance.findFirst({
    where: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId,
      variantId: input.variantId,
      binId: input.binId,
      stockStatus: input.stockStatus,
    },
  });

  const nextReserved = Math.max(0, (existing?.qtyReserved ?? 0) + (input.reservedDelta ?? 0));
  const nextOnHand = Math.max(0, (existing?.qtyOnHand ?? 0) + input.onHandDelta);
  const rawAvailable = (existing?.qtyAvailable ?? 0) + (input.availableDelta ?? 0);
  const nextAvailable = Math.max(0, Math.min(nextOnHand - nextReserved, rawAvailable));

  if (existing) {
    return tx.warehouseStockBalance.update({
      where: { id: existing.id },
      data: {
        qtyOnHand: nextOnHand,
        qtyReserved: nextReserved,
        qtyAvailable: nextAvailable,
      },
    });
  }

  return tx.warehouseStockBalance.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId,
      variantId: input.variantId,
      binId: input.binId,
      stockStatus: input.stockStatus,
      qtyOnHand: nextOnHand,
      qtyReserved: nextReserved,
      qtyAvailable: nextAvailable,
    },
  });
}

async function getInventorySnapshotDb(db: Tx, orgId: string, siteId: string, variantId?: string) {
  const balances = await db.warehouseStockBalance.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      ...(variantId ? { variantId } : {}),
    },
    include: {
      bin: {
        select: {
          id: true,
          code: true,
          zone: { select: { id: true, code: true, name: true } },
        },
      },
      variant: {
        include: {
          productCatalog: {
            select: { id: true, name: true },
          },
        },
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });

  const reservations = variantId
    ? await db.warehouseStockReservation.findMany({
        where: { orgId, warehouseSiteId: siteId, variantId },
        include: {
          allocations: true,
        },
        orderBy: [{ createdAt: 'desc' }],
      })
    : [];

  return {
    totals: {
      qtyOnHand: balances.reduce((sum, row) => sum + row.qtyOnHand, 0),
      qtyReserved: balances.reduce((sum, row) => sum + row.qtyReserved, 0),
      qtyAvailable: balances.reduce((sum, row) => sum + row.qtyAvailable, 0),
    },
    balances,
    reservations,
  };
}

async function getInventorySnapshot(orgId: string, siteId: string, variantId?: string) {
  return getInventorySnapshotDb(prisma, orgId, siteId, variantId);
}

function mapCompatibilityMovementType(source: 'receipt' | 'transfer' | 'reserve' | 'release' | 'consume') {
  if (source === 'receipt') return 'in';
  if (source === 'transfer') return 'transfer';
  if (source === 'reserve') return 'reserved';
  if (source === 'consume') return 'out';
  return 'reservation_released';
}

async function createCompatibilityMovement(
  tx: Tx,
  input: {
    orgId: string;
    itemId: string;
    type: string;
    qty: number;
    qtyBefore: number;
    qtyAfter: number;
    sourceId?: string;
    sourceType?: string;
    reason?: string;
    author?: string;
  },
) {
  await tx.warehouseMovement.create({
    data: {
      orgId: input.orgId,
      itemId: input.itemId,
      type: input.type,
      qty: input.qty,
      qtyBefore: input.qtyBefore,
      qtyAfter: input.qtyAfter,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      reason: input.reason,
      author: input.author ?? 'system',
    },
  });
}

export async function listVariants(orgId: string) {
  return prisma.warehouseVariant.findMany({
    where: { orgId },
    include: {
      productCatalog: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ updatedAt: 'desc' }],
  });
}

export async function upsertVariant(orgId: string, dto: UpsertWarehouseVariantDto) {
  const product = await prisma.warehouseProductCatalog.findFirst({
    where: { id: dto.productCatalogId, orgId },
    include: {
      fieldLinks: {
        include: { definition: true },
      },
    },
  });
  if (!product) {
    throw new AppError(404, 'Каталожный продукт не найден', 'NOT_FOUND');
  }

  const attributes = normalizeStringMap(dto.attributesJson);
  const availabilityFields = new Set(
    product.fieldLinks
      .filter((link) => link.definition.affectsAvailability)
      .map((link) => link.definition.code),
  );
  const attributesForKey =
    availabilityFields.size > 0
      ? Object.fromEntries(Object.entries(attributes).filter(([key]) => availabilityFields.has(key)))
      : attributes;

  const variantKey = dto.variantKey?.trim() || buildVariantKey(product.name, attributesForKey);
  if (!variantKey) {
    throw new AppError(400, 'Не удалось сформировать variantKey', 'VALIDATION');
  }

  const attributesSummary = dto.attributesSummary?.trim() || buildAttributesSummary(attributes);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.warehouseVariant.findFirst({
      where: { orgId, productCatalogId: product.id, variantKey },
      include: { productCatalog: true },
    });

    const variant = existing
      ? await tx.warehouseVariant.update({
          where: { id: existing.id },
          data: {
            attributesJson: Object.keys(attributes).length > 0 ? (attributes as Prisma.InputJsonValue) : undefined,
            attributesSummary,
            isActive: true,
          },
          include: { productCatalog: true },
        })
      : await tx.warehouseVariant.create({
          data: {
            orgId,
            productCatalogId: product.id,
            variantKey,
            attributesJson: Object.keys(attributes).length > 0 ? (attributes as Prisma.InputJsonValue) : undefined,
            attributesSummary,
          },
          include: { productCatalog: true },
        });

    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, variant);

    await createOutboxRecord(tx, {
      orgId,
      aggregateType: 'warehouse.variant',
      aggregateId: variant.id,
      eventType: existing ? 'warehouse.variant.updated' : 'warehouse.variant.created',
      payload: {
        variantId: variant.id,
        productCatalogId: product.id,
        variantKey: variant.variantKey,
        compatibilityItemId: compatibilityItem.id,
      },
    });

    return {
      variant,
      compatibilityItem: {
        id: compatibilityItem.id,
        name: compatibilityItem.name,
        qty: compatibilityItem.qty,
        qtyReserved: compatibilityItem.qtyReserved,
      },
    };
  });
}

export async function listSiteBalances(orgId: string, siteId: string, filters?: { variantId?: string; binId?: string }) {
  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true, code: true, name: true },
  });
  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const balances = await prisma.warehouseStockBalance.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      ...(filters?.variantId ? { variantId: filters.variantId } : {}),
      ...(filters?.binId ? { binId: filters.binId } : {}),
    },
    include: {
      bin: {
        select: {
          id: true,
          code: true,
          zone: { select: { id: true, code: true, name: true } },
        },
      },
      variant: {
        include: {
          productCatalog: {
            select: { id: true, name: true },
          },
        },
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });

  return {
    site,
    totals: {
      qtyOnHand: balances.reduce((sum, row) => sum + row.qtyOnHand, 0),
      qtyReserved: balances.reduce((sum, row) => sum + row.qtyReserved, 0),
      qtyAvailable: balances.reduce((sum, row) => sum + row.qtyAvailable, 0),
    },
    count: balances.length,
    results: balances,
  };
}

export async function postStockReceipt(orgId: string, dto: PostStockReceiptDto) {
  ensurePositiveNumber(dto.qty, 'Количество');
  const stockStatus = dto.stockStatus?.trim() || 'available';

  const [variant, bin] = await Promise.all([
    getVariantOrThrow(orgId, dto.variantId),
    ensureSiteAndBin(orgId, dto.warehouseSiteId, dto.toBinId),
  ]);

  const existing = await prisma.warehouseStockLedgerEvent.findFirst({
    where: { orgId, idempotencyKey: dto.idempotencyKey },
  });
  if (existing) {
    return {
      replayed: true,
      ledgerEvent: existing,
      snapshot: await getInventorySnapshot(orgId, existing.warehouseSiteId, existing.variantId),
    };
  }

  return prisma.$transaction(async (tx) => {
    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, variant);
    const availableDelta = stockStatus === 'available' ? dto.qty : 0;
    const updatedBalance = await upsertBalance(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      variantId: dto.variantId,
      binId: dto.toBinId,
      stockStatus,
      onHandDelta: dto.qty,
      availableDelta,
    });

    const ledgerEvent = await tx.warehouseStockLedgerEvent.create({
      data: {
        orgId,
        warehouseSiteId: dto.warehouseSiteId,
        variantId: dto.variantId,
        toBinId: dto.toBinId,
        eventType: 'receipt',
        qtyDelta: dto.qty,
        stockStatusTo: stockStatus,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        sourceLineId: dto.sourceLineId,
        correlationId: dto.idempotencyKey,
        idempotencyKey: dto.idempotencyKey,
        actorUserId: dto.actorUserId,
        actorName: dto.actorName ?? 'system',
      },
    });

    let nextCompatibilityQty = compatibilityItem.qty;
    if (availableDelta !== 0) {
      nextCompatibilityQty += availableDelta;
      await tx.warehouseItem.update({
        where: { id: compatibilityItem.id },
        data: { qty: nextCompatibilityQty },
      });
      await createCompatibilityMovement(tx, {
        orgId,
        itemId: compatibilityItem.id,
        type: mapCompatibilityMovementType('receipt'),
        qty: availableDelta,
        qtyBefore: compatibilityItem.qty,
        qtyAfter: nextCompatibilityQty,
        sourceId: dto.sourceId,
        sourceType: dto.sourceType,
        reason: dto.reason ?? `Canonical receipt into ${bin.code}`,
        author: dto.actorName ?? 'system',
      });
    }

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      aggregateType: 'warehouse.inventory',
      aggregateId: ledgerEvent.id,
      eventType: 'warehouse.stock.changed',
      payload: {
        mode: 'receipt',
        ledgerEventId: ledgerEvent.id,
        variantId: dto.variantId,
        warehouseSiteId: dto.warehouseSiteId,
        toBinId: dto.toBinId,
        qty: dto.qty,
        stockStatus,
      },
    });

    return {
      replayed: false,
      ledgerEvent,
      balance: updatedBalance,
      compatibilityItem: {
        id: compatibilityItem.id,
        qty: nextCompatibilityQty,
        qtyReserved: compatibilityItem.qtyReserved,
      },
    };
  });
}

export async function postStockTransfer(orgId: string, dto: PostStockTransferDto) {
  ensurePositiveNumber(dto.qty, 'Количество');
  const stockStatusFrom = dto.stockStatusFrom?.trim() || 'available';
  const stockStatusTo = dto.stockStatusTo?.trim() || stockStatusFrom;

  if (dto.fromBinId === dto.toBinId && stockStatusFrom === stockStatusTo) {
    throw new AppError(400, 'Трансфер не меняет состояние склада', 'VALIDATION');
  }

  const [variant, fromBin, toBin] = await Promise.all([
    getVariantOrThrow(orgId, dto.variantId),
    ensureSiteAndBin(orgId, dto.warehouseSiteId, dto.fromBinId),
    ensureSiteAndBin(orgId, dto.warehouseSiteId, dto.toBinId),
  ]);

  const existing = await prisma.warehouseStockLedgerEvent.findFirst({
    where: { orgId, idempotencyKey: dto.idempotencyKey },
  });
  if (existing) {
    return {
      replayed: true,
      ledgerEvent: existing,
      snapshot: await getInventorySnapshot(orgId, existing.warehouseSiteId, existing.variantId),
    };
  }

  const sourceBalance = await prisma.warehouseStockBalance.findFirst({
    where: {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      variantId: dto.variantId,
      binId: dto.fromBinId,
      stockStatus: stockStatusFrom,
    },
  });
  if (!sourceBalance) {
    throw new AppError(404, 'Исходный баланс не найден', 'NOT_FOUND');
  }

  const sourceCapacity = stockStatusFrom === 'available' ? sourceBalance.qtyAvailable : sourceBalance.qtyOnHand;
  if (sourceCapacity < dto.qty) {
    throw new AppError(409, 'Недостаточно остатка для трансфера', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, variant);

    const updatedSource = await upsertBalance(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      variantId: dto.variantId,
      binId: dto.fromBinId,
      stockStatus: stockStatusFrom,
      onHandDelta: -dto.qty,
      availableDelta: stockStatusFrom === 'available' ? -dto.qty : 0,
    });

    const updatedTarget = await upsertBalance(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      variantId: dto.variantId,
      binId: dto.toBinId,
      stockStatus: stockStatusTo,
      onHandDelta: dto.qty,
      availableDelta: stockStatusTo === 'available' ? dto.qty : 0,
    });

    const ledgerEvent = await tx.warehouseStockLedgerEvent.create({
      data: {
        orgId,
        warehouseSiteId: dto.warehouseSiteId,
        variantId: dto.variantId,
        fromBinId: dto.fromBinId,
        toBinId: dto.toBinId,
        eventType: 'transfer',
        qtyDelta: dto.qty,
        stockStatusFrom,
        stockStatusTo,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        sourceLineId: dto.sourceLineId,
        correlationId: dto.idempotencyKey,
        idempotencyKey: dto.idempotencyKey,
        actorUserId: dto.actorUserId,
        actorName: dto.actorName ?? 'system',
      },
    });

    const compatibilityAvailableDelta =
      (stockStatusTo === 'available' ? dto.qty : 0) -
      (stockStatusFrom === 'available' ? dto.qty : 0);

    let nextCompatibilityQty = compatibilityItem.qty;
    if (compatibilityAvailableDelta !== 0) {
      nextCompatibilityQty += compatibilityAvailableDelta;
      await tx.warehouseItem.update({
        where: { id: compatibilityItem.id },
        data: { qty: nextCompatibilityQty },
      });
      await createCompatibilityMovement(tx, {
        orgId,
        itemId: compatibilityItem.id,
        type: mapCompatibilityMovementType('transfer'),
        qty: compatibilityAvailableDelta,
        qtyBefore: compatibilityItem.qty,
        qtyAfter: nextCompatibilityQty,
        sourceId: dto.sourceId,
        sourceType: dto.sourceType,
        reason: dto.reason ?? `Canonical transfer ${fromBin.code} -> ${toBin.code}`,
        author: dto.actorName ?? 'system',
      });
    }

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      aggregateType: 'warehouse.inventory',
      aggregateId: ledgerEvent.id,
      eventType: 'warehouse.stock.changed',
      payload: {
        mode: 'transfer',
        ledgerEventId: ledgerEvent.id,
        variantId: dto.variantId,
        warehouseSiteId: dto.warehouseSiteId,
        fromBinId: dto.fromBinId,
        toBinId: dto.toBinId,
        qty: dto.qty,
        stockStatusFrom,
        stockStatusTo,
      },
    });

    return {
      replayed: false,
      ledgerEvent,
      sourceBalance: updatedSource,
      targetBalance: updatedTarget,
      compatibilityItem: {
        id: compatibilityItem.id,
        qty: nextCompatibilityQty,
        qtyReserved: compatibilityItem.qtyReserved,
      },
    };
  });
}

export async function createStockReservation(orgId: string, dto: CreateStockReservationDto) {
  ensurePositiveNumber(dto.qty, 'Количество');

  const variant = await getVariantOrThrow(orgId, dto.variantId);
  const site = await prisma.warehouseSite.findFirst({
    where: { id: dto.warehouseSiteId, orgId },
    select: { id: true, code: true, name: true },
  });
  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  const existing = await prisma.warehouseStockReservation.findFirst({
    where: { orgId, idempotencyKey: dto.idempotencyKey },
    include: { allocations: true },
  });
  if (existing) {
    return {
      replayed: true,
      reservation: existing,
      snapshot: await getInventorySnapshot(orgId, existing.warehouseSiteId, existing.variantId),
    };
  }

  const balances = await prisma.warehouseStockBalance.findMany({
    where: {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      variantId: dto.variantId,
      stockStatus: 'available',
      qtyAvailable: { gt: 0 },
    },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
  });

  const totalAvailable = balances.reduce((sum, row) => sum + row.qtyAvailable, 0);
  if (totalAvailable < dto.qty) {
    throw new AppError(409, 'Недостаточно available stock для резерва', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, variant);

    const compatibilityReservation = await tx.warehouseReservation.create({
      data: {
        orgId,
        itemId: compatibilityItem.id,
        qty: dto.qty,
        sourceId: dto.sourceId,
        sourceType: dto.sourceType,
        status: 'active',
      },
    });

    const reservation = await tx.warehouseStockReservation.create({
      data: {
        orgId,
        warehouseSiteId: dto.warehouseSiteId,
        variantId: dto.variantId,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
        sourceLineId: dto.sourceLineId,
        qtyReserved: dto.qty,
        idempotencyKey: dto.idempotencyKey,
        compatibilityReservationId: compatibilityReservation.id,
      },
    });

    let remaining = dto.qty;
    const allocations: Array<{ stockBalanceId: string; binId: string; qtyReserved: number }> = [];

    for (const balance of balances) {
      if (remaining <= 0) break;
      const allocated = Math.min(remaining, balance.qtyAvailable);
      remaining -= allocated;

      await tx.warehouseStockBalance.update({
        where: { id: balance.id },
        data: {
          qtyReserved: { increment: allocated },
          qtyAvailable: { decrement: allocated },
        },
      });

      allocations.push({
        stockBalanceId: balance.id,
        binId: balance.binId,
        qtyReserved: allocated,
      });
    }

    if (allocations.length === 0) {
      throw new AppError(409, 'Не удалось аллоцировать резерв', 'CONFLICT');
    }

    await tx.warehouseStockReservationAllocation.createMany({
      data: allocations.map((row) => ({
        reservationId: reservation.id,
        stockBalanceId: row.stockBalanceId,
        binId: row.binId,
        qtyReserved: row.qtyReserved,
      })),
    });

    await tx.warehouseItem.update({
      where: { id: compatibilityItem.id },
      data: { qtyReserved: { increment: dto.qty } },
    });

    await createCompatibilityMovement(tx, {
      orgId,
      itemId: compatibilityItem.id,
      type: mapCompatibilityMovementType('reserve'),
      qty: -dto.qty,
      qtyBefore: compatibilityItem.qty,
      qtyAfter: compatibilityItem.qty,
      sourceId: dto.sourceId,
      sourceType: dto.sourceType,
      reason: dto.reason ?? `Canonical reservation for ${dto.sourceType}:${dto.sourceId}`,
      author: dto.actorName ?? 'system',
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: dto.warehouseSiteId,
      aggregateType: 'warehouse.reservation',
      aggregateId: reservation.id,
      eventType: 'warehouse.reservation.changed',
      payload: {
        mode: 'reserve',
        reservationId: reservation.id,
        variantId: dto.variantId,
        warehouseSiteId: dto.warehouseSiteId,
        qty: dto.qty,
        sourceType: dto.sourceType,
        sourceId: dto.sourceId,
      },
    });

    return {
      replayed: false,
      reservation: await tx.warehouseStockReservation.findFirst({
        where: { id: reservation.id },
        include: { allocations: true },
      }),
      compatibilityItem: {
        id: compatibilityItem.id,
        qty: compatibilityItem.qty,
        qtyReserved: compatibilityItem.qtyReserved + dto.qty,
      },
    };
  });
}

export async function releaseStockReservation(orgId: string, reservationId: string, actorName?: string, reason?: string) {
  const reservation = await prisma.warehouseStockReservation.findFirst({
    where: { id: reservationId, orgId },
    include: {
      allocations: true,
      variant: {
        include: { productCatalog: true },
      },
    },
  });
  if (!reservation) {
    throw new AppError(404, 'Резерв не найден', 'NOT_FOUND');
  }

  if (reservation.status !== 'active') {
    return {
      replayed: true,
      reservation,
      snapshot: await getInventorySnapshot(orgId, reservation.warehouseSiteId, reservation.variantId),
    };
  }

  return prisma.$transaction(async (tx) => {
    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, reservation.variant);

    for (const allocation of reservation.allocations) {
      await tx.warehouseStockBalance.update({
        where: { id: allocation.stockBalanceId },
        data: {
          qtyReserved: { decrement: allocation.qtyReserved },
          qtyAvailable: { increment: allocation.qtyReserved },
        },
      });
    }

    const releasedAt = new Date();
    const updatedReservation = await tx.warehouseStockReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'released',
        releasedAt,
      },
      include: { allocations: true },
    });

    if (reservation.compatibilityReservationId) {
      await tx.warehouseReservation.update({
        where: { id: reservation.compatibilityReservationId },
        data: { status: 'released' },
      });
    }

    await tx.warehouseItem.update({
      where: { id: compatibilityItem.id },
      data: {
        qtyReserved: { decrement: reservation.qtyReserved },
      },
    });

    await createCompatibilityMovement(tx, {
      orgId,
      itemId: compatibilityItem.id,
      type: mapCompatibilityMovementType('release'),
      qty: reservation.qtyReserved,
      qtyBefore: compatibilityItem.qty,
      qtyAfter: compatibilityItem.qty,
      sourceId: reservation.sourceId,
      sourceType: reservation.sourceType,
      reason: reason ?? `Canonical reservation release ${reservation.id}`,
      author: actorName ?? 'system',
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: reservation.warehouseSiteId,
      aggregateType: 'warehouse.reservation',
      aggregateId: reservation.id,
      eventType: 'warehouse.reservation.changed',
      payload: {
        mode: 'release',
        reservationId: reservation.id,
        variantId: reservation.variantId,
        warehouseSiteId: reservation.warehouseSiteId,
        qty: reservation.qtyReserved,
      },
    });

    return {
      replayed: false,
      reservation: updatedReservation,
      compatibilityItem: {
        id: compatibilityItem.id,
        qty: compatibilityItem.qty,
        qtyReserved: compatibilityItem.qtyReserved - reservation.qtyReserved,
      },
    };
  });
}

export async function releaseStockReservationInTx(
  tx: WarehouseInventoryTx,
  orgId: string,
  reservationId: string,
  actorName?: string,
  reason?: string,
) {
  const reservation = await tx.warehouseStockReservation.findFirst({
    where: { id: reservationId, orgId },
    include: {
      allocations: true,
      variant: {
        include: { productCatalog: true },
      },
    },
  });
  if (!reservation) {
    throw new AppError(404, 'Резерв не найден', 'NOT_FOUND');
  }

  if (reservation.status !== 'active') {
    return {
      replayed: true,
      reservation,
      snapshot: await getInventorySnapshotDb(tx, orgId, reservation.warehouseSiteId, reservation.variantId),
    };
  }

  const compatibilityItem = await ensureCompatibilityItem(tx, orgId, reservation.variant);

  for (const allocation of reservation.allocations) {
    await tx.warehouseStockBalance.update({
      where: { id: allocation.stockBalanceId },
      data: {
        qtyReserved: { decrement: allocation.qtyReserved },
        qtyAvailable: { increment: allocation.qtyReserved },
      },
    });
  }

  const releasedAt = new Date();
  const updatedReservation = await tx.warehouseStockReservation.update({
    where: { id: reservation.id },
    data: {
      status: 'released',
      releasedAt,
    },
    include: { allocations: true },
  });

  if (reservation.compatibilityReservationId) {
    await tx.warehouseReservation.update({
      where: { id: reservation.compatibilityReservationId },
      data: { status: 'released' },
    });
  }

  await tx.warehouseItem.update({
    where: { id: compatibilityItem.id },
    data: {
      qtyReserved: { decrement: reservation.qtyReserved },
    },
  });

  await createCompatibilityMovement(tx, {
    orgId,
    itemId: compatibilityItem.id,
    type: mapCompatibilityMovementType('release'),
    qty: reservation.qtyReserved,
    qtyBefore: compatibilityItem.qty,
    qtyAfter: compatibilityItem.qty,
    sourceId: reservation.sourceId,
    sourceType: reservation.sourceType,
    reason: reason ?? `Canonical reservation release ${reservation.id}`,
    author: actorName ?? 'system',
  });

  await createOutboxRecord(tx, {
    orgId,
    warehouseSiteId: reservation.warehouseSiteId,
    aggregateType: 'warehouse.reservation',
    aggregateId: reservation.id,
    eventType: 'warehouse.reservation.changed',
    payload: {
      mode: 'release',
      reservationId: reservation.id,
      variantId: reservation.variantId,
      warehouseSiteId: reservation.warehouseSiteId,
      qty: reservation.qtyReserved,
    },
  });

  return {
    replayed: false,
    reservation: updatedReservation,
    compatibilityItem: {
      id: compatibilityItem.id,
      qty: compatibilityItem.qty,
      qtyReserved: compatibilityItem.qtyReserved - reservation.qtyReserved,
    },
  };
}

export async function consumeStockReservation(
  orgId: string,
  reservationId: string,
  actorName?: string,
  reason?: string,
): Promise<ConsumeStockReservationResult> {
  const reservation = await prisma.warehouseStockReservation.findFirst({
    where: { id: reservationId, orgId },
    include: {
      allocations: true,
      variant: {
        include: { productCatalog: true },
      },
    },
  });
  if (!reservation) {
    throw new AppError(404, 'Резерв не найден', 'NOT_FOUND');
  }

  if (reservation.status === 'consumed') {
    return {
      replayed: true,
      reservation,
      snapshot: await getInventorySnapshot(orgId, reservation.warehouseSiteId, reservation.variantId),
    };
  }

  if (reservation.status !== 'active') {
    throw new AppError(409, 'Резерв нельзя списать из текущего статуса', 'CONFLICT');
  }

  return prisma.$transaction(async (tx) => {
    const compatibilityItem = await ensureCompatibilityItem(tx, orgId, reservation.variant);
    const ledgerEvents: Array<{ id: string; fromBinId: string | null; qtyDelta: number }> = [];

    for (const allocation of reservation.allocations) {
      const balance = await tx.warehouseStockBalance.findFirst({
        where: { id: allocation.stockBalanceId, orgId },
      });
      if (!balance) {
        throw new AppError(404, 'Баланс резерва не найден', 'NOT_FOUND');
      }

      if (balance.qtyReserved < allocation.qtyReserved || balance.qtyOnHand < allocation.qtyReserved) {
        throw new AppError(409, 'Резервный баланс поврежден или уже списан', 'CONFLICT');
      }

      await tx.warehouseStockBalance.update({
        where: { id: allocation.stockBalanceId },
        data: {
          qtyOnHand: { decrement: allocation.qtyReserved },
          qtyReserved: { decrement: allocation.qtyReserved },
        },
      });

      const ledgerEvent = await tx.warehouseStockLedgerEvent.create({
        data: {
          orgId,
          warehouseSiteId: reservation.warehouseSiteId,
          variantId: reservation.variantId,
          fromBinId: allocation.binId,
          toBinId: null,
          eventType: 'consume_reservation',
          qtyDelta: -allocation.qtyReserved,
          stockStatusFrom: 'available',
          stockStatusTo: 'shipped',
          sourceType: reservation.sourceType,
          sourceId: reservation.sourceId,
          sourceLineId: reservation.sourceLineId,
          correlationId: `consume:${reservation.id}`,
          idempotencyKey: `consume:${reservation.id}:${allocation.id}`,
          actorUserId: null,
          actorName: actorName ?? 'system',
        },
      });

      ledgerEvents.push({
        id: ledgerEvent.id,
        fromBinId: ledgerEvent.fromBinId,
        qtyDelta: ledgerEvent.qtyDelta,
      });
    }

    const consumedAt = new Date();
    const updatedReservation = await tx.warehouseStockReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'consumed',
        consumedAt,
      },
      include: { allocations: true },
    });

    if (reservation.compatibilityReservationId) {
      await tx.warehouseReservation.update({
        where: { id: reservation.compatibilityReservationId },
        data: { status: 'released' },
      });
    }

    await tx.warehouseItem.update({
      where: { id: compatibilityItem.id },
      data: {
        qty: { decrement: reservation.qtyReserved },
        qtyReserved: { decrement: reservation.qtyReserved },
      },
    });

    await createCompatibilityMovement(tx, {
      orgId,
      itemId: compatibilityItem.id,
      type: mapCompatibilityMovementType('consume'),
      qty: -reservation.qtyReserved,
      qtyBefore: compatibilityItem.qty,
      qtyAfter: compatibilityItem.qty - reservation.qtyReserved,
      sourceId: reservation.sourceId,
      sourceType: reservation.sourceType,
      reason: reason ?? `Canonical reservation consume ${reservation.id}`,
      author: actorName ?? 'system',
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: reservation.warehouseSiteId,
      aggregateType: 'warehouse.reservation',
      aggregateId: reservation.id,
      eventType: 'warehouse.stock.changed',
      payload: {
        mode: 'consume_reservation',
        reservationId: reservation.id,
        variantId: reservation.variantId,
        warehouseSiteId: reservation.warehouseSiteId,
        qty: reservation.qtyReserved,
        sourceType: reservation.sourceType,
        sourceId: reservation.sourceId,
      },
    });

    return {
      replayed: false,
      reservation: updatedReservation,
      compatibilityItem: {
        id: compatibilityItem.id,
        qty: compatibilityItem.qty - reservation.qtyReserved,
        qtyReserved: compatibilityItem.qtyReserved - reservation.qtyReserved,
      },
      ledgerEvents,
    };
  });
}

export async function consumeStockReservationInTx(
  tx: WarehouseInventoryTx,
  orgId: string,
  reservationId: string,
  actorName?: string,
  reason?: string,
): Promise<ConsumeStockReservationResult> {
  const reservation = await tx.warehouseStockReservation.findFirst({
    where: { id: reservationId, orgId },
    include: {
      allocations: true,
      variant: {
        include: { productCatalog: true },
      },
    },
  });
  if (!reservation) {
    throw new AppError(404, 'Резерв не найден', 'NOT_FOUND');
  }

  if (reservation.status === 'consumed') {
    return {
      replayed: true,
      reservation,
      snapshot: await getInventorySnapshotDb(tx, orgId, reservation.warehouseSiteId, reservation.variantId),
    };
  }

  if (reservation.status !== 'active') {
    throw new AppError(409, 'Резерв нельзя списать из текущего статуса', 'CONFLICT');
  }

  const compatibilityItem = await ensureCompatibilityItem(tx, orgId, reservation.variant);
  const ledgerEvents: Array<{ id: string; fromBinId: string | null; qtyDelta: number }> = [];

  for (const allocation of reservation.allocations) {
    const balance = await tx.warehouseStockBalance.findFirst({
      where: { id: allocation.stockBalanceId, orgId },
    });
    if (!balance) {
      throw new AppError(404, 'Баланс резерва не найден', 'NOT_FOUND');
    }

    if (balance.qtyReserved < allocation.qtyReserved || balance.qtyOnHand < allocation.qtyReserved) {
      throw new AppError(409, 'Резервный баланс поврежден или уже списан', 'CONFLICT');
    }

    await tx.warehouseStockBalance.update({
      where: { id: allocation.stockBalanceId },
      data: {
        qtyOnHand: { decrement: allocation.qtyReserved },
        qtyReserved: { decrement: allocation.qtyReserved },
      },
    });

    const ledgerEvent = await tx.warehouseStockLedgerEvent.create({
      data: {
        orgId,
        warehouseSiteId: reservation.warehouseSiteId,
        variantId: reservation.variantId,
        fromBinId: allocation.binId,
        toBinId: null,
        eventType: 'consume_reservation',
        qtyDelta: -allocation.qtyReserved,
        stockStatusFrom: 'available',
        stockStatusTo: 'shipped',
        sourceType: reservation.sourceType,
        sourceId: reservation.sourceId,
        sourceLineId: reservation.sourceLineId,
        correlationId: `consume:${reservation.id}`,
        idempotencyKey: `consume:${reservation.id}:${allocation.id}`,
        actorUserId: null,
        actorName: actorName ?? 'system',
      },
    });

    ledgerEvents.push({
      id: ledgerEvent.id,
      fromBinId: ledgerEvent.fromBinId,
      qtyDelta: ledgerEvent.qtyDelta,
    });
  }

  const consumedAt = new Date();
  const updatedReservation = await tx.warehouseStockReservation.update({
    where: { id: reservation.id },
    data: {
      status: 'consumed',
      consumedAt,
    },
    include: { allocations: true },
  });

  if (reservation.compatibilityReservationId) {
    await tx.warehouseReservation.update({
      where: { id: reservation.compatibilityReservationId },
      data: { status: 'released' },
    });
  }

  await tx.warehouseItem.update({
    where: { id: compatibilityItem.id },
    data: {
      qty: { decrement: reservation.qtyReserved },
      qtyReserved: { decrement: reservation.qtyReserved },
    },
  });

  await createCompatibilityMovement(tx, {
    orgId,
    itemId: compatibilityItem.id,
    type: mapCompatibilityMovementType('consume'),
    qty: -reservation.qtyReserved,
    qtyBefore: compatibilityItem.qty,
    qtyAfter: compatibilityItem.qty - reservation.qtyReserved,
    sourceId: reservation.sourceId,
    sourceType: reservation.sourceType,
    reason: reason ?? `Canonical reservation consume ${reservation.id}`,
    author: actorName ?? 'system',
  });

  await createOutboxRecord(tx, {
    orgId,
    warehouseSiteId: reservation.warehouseSiteId,
    aggregateType: 'warehouse.reservation',
    aggregateId: reservation.id,
    eventType: 'warehouse.stock.changed',
    payload: {
      mode: 'consume_reservation',
      reservationId: reservation.id,
      variantId: reservation.variantId,
      warehouseSiteId: reservation.warehouseSiteId,
      qty: reservation.qtyReserved,
      sourceType: reservation.sourceType,
      sourceId: reservation.sourceId,
    },
  });

  return {
    replayed: false,
    reservation: updatedReservation,
    compatibilityItem: {
      id: compatibilityItem.id,
      qty: compatibilityItem.qty - reservation.qtyReserved,
      qtyReserved: compatibilityItem.qtyReserved - reservation.qtyReserved,
    },
    ledgerEvents,
  };
}
