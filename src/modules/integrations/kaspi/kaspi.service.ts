import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../../lib/errors.js';
import {
  confirmKaspiCompletedOrder,
  hydrateKaspiOrder,
  listKaspiOrders,
  sendKaspiCompletionCode,
  type JsonApiResource,
  type KaspiHydratedOrder,
  type KaspiOrderSummary,
} from './client.js';
import {
  createStockReservation,
  consumeStockReservationInTx,
  releaseStockReservationInTx,
} from '../../warehouse/warehouse-inventory-core.service.js';
import type {
  ConfirmCompletionCodeInput,
  ConfirmCompletionCodeResult,
  KaspiConnectionView,
  KaspiConnectionHistoryItemView,
  KaspiExportResult,
  KaspiOrderDetailView,
  KaspiOrderItemView,
  KaspiOrdersSummaryView,
  KaspiOrderView,
  KaspiStockImpactState,
  ListKaspiOrdersInput,
  SaveKaspiConnectionInput,
  SendCompletionCodeResult,
  SyncKaspiOrdersResult,
} from './types.js';

type KaspiOrderLinkRecord = Prisma.KaspiOrderLinkGetPayload<{
  select: {
    id: true;
    orgId: true;
    connectionId: true;
    externalOrderId: true;
    externalOrderCode: true;
    externalState: true;
    externalStatus: true;
    externalDeliveryMode: true;
    internalOrderId: true;
    internalOrderType: true;
    rawPayload: true;
    lastExternalUpdateAt: true;
    acceptedAt: true;
    completedAt: true;
    cancelledAt: true;
    lastSyncedAt: true;
    syncError: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

type WarehouseItemMatchCandidate = {
  id: string;
  name: string;
  sku: string | null;
  productCatalogId: string | null;
  variantKey: string | null;
};

type WarehouseVariantCandidate = {
  id: string;
  productCatalogId: string;
  variantKey: string;
};

type StockReservationRecord = {
  id: string;
  sourceId: string;
  sourceLineId: string | null;
  status: string;
};

type StoredKaspiPayload = {
  order: JsonApiResource | null;
  entries: Array<{
    entry: JsonApiResource | null;
    merchantProduct: JsonApiResource | null;
  }>;
};

type ParsedKaspiItem = {
  externalEntryId: string;
  entryNumber: number | null;
  quantity: number | null;
  totalPrice: number | null;
  basePrice: number | null;
  deliveryCost: number | null;
  weight: number | null;
  unitType: string | null;
  categoryCode: string | null;
  categoryTitle: string | null;
  merchantSku: string | null;
  productName: string | null;
  manufacturer: string | null;
};

type WarehouseMatchContext = {
  site: { id: string; code: string; name: string } | null;
  warehouseItemsBySku: Map<string, WarehouseItemMatchCandidate[]>;
  variantsByKey: Map<string, WarehouseVariantCandidate>;
  reservationsByOrderId: Map<string, Map<string, StockReservationRecord>>;
};

type BuiltKaspiOrderView = {
  view: KaspiOrderView;
  customerSnapshot: Record<string, unknown> | null;
  deliverySnapshot: Record<string, unknown> | null;
  rawPayloadPresent: boolean;
};

const KASPI_RELEASE_STATUSES = new Set(['CANCELLED', 'RETURNED']);
const KASPI_CANCELLATION_STATUSES = new Set(['CANCELLED', 'CANCELLING', 'RETURNED']);
const KASPI_RESERVATION_STATUSES = new Set(['ACCEPTED_BY_MERCHANT', 'COMPLETED']);
const KASPI_SYNC_LOOKBACK_DAYS = 90;
const KASPI_SYNC_WINDOW_DAYS = 14;
const KASPI_SYNC_MAX_PAGES_PER_WINDOW = 100;
const KASPI_COMPLETION_WRITE_ENABLED = false;

function maskToken(tokenLast4: string) {
  return `**** **** **** ${tokenLast4}`;
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeSku(value: string) {
  return value.trim().toLowerCase();
}

function variantCompositeKey(productCatalogId: string, variantKey: string) {
  return `${productCatalogId}::${variantKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const fromNumeric = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
      if (!Number.isNaN(fromNumeric.getTime())) {
        return fromNumeric;
      }
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function readTimestampIso(value: unknown): string | null {
  return readTimestamp(value)?.toISOString() ?? null;
}

function coerceExternalTimestamp(value: string | null) {
  const parsed = readTimestamp(value);
  return parsed ?? new Date();
}

function mapConnection(record: {
  id: string;
  orgId: string;
  sellerName: string | null;
  tokenLast4: string;
  isActive: boolean;
  archivedAt: Date | null;
  lastCheckedAt: Date | null;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): KaspiConnectionView {
  return {
    id: record.id,
    orgId: record.orgId,
    sellerName: record.sellerName,
    tokenMasked: maskToken(record.tokenLast4),
    isActive: record.isActive,
    archivedAt: toIso(record.archivedAt),
    lastCheckedAt: toIso(record.lastCheckedAt),
    lastSyncAt: toIso(record.lastSyncAt),
    lastSyncError: record.lastSyncError,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function parseStoredPayload(rawPayload: Prisma.JsonValue | null): StoredKaspiPayload {
  if (!isRecord(rawPayload)) {
    return { order: null, entries: [] };
  }

  const order = isRecord(rawPayload.order) ? (rawPayload.order as JsonApiResource) : null;
  const entriesSource = Array.isArray(rawPayload.entries) ? rawPayload.entries : [];

  return {
    order,
    entries: entriesSource.map((item) => ({
      entry: isRecord(item) && isRecord(item.entry) ? (item.entry as JsonApiResource) : null,
      merchantProduct: isRecord(item) && isRecord(item.merchantProduct)
        ? (item.merchantProduct as JsonApiResource)
        : null,
    })),
  };
}

function parseKaspiItems(payload: StoredKaspiPayload): ParsedKaspiItem[] {
  return payload.entries
    .map((item) => {
      const entry = item.entry;
      if (!entry) {
        return null;
      }

      const attributes = entry.attributes ?? {};
      const merchantAttributes = item.merchantProduct?.attributes ?? {};
      const category = isRecord(attributes.category) ? attributes.category : null;

      return {
        externalEntryId: readString(entry.id) ?? '',
        entryNumber: readNumber(attributes.entryNumber),
        quantity: readNumber(attributes.quantity),
        totalPrice: readNumber(attributes.totalPrice),
        basePrice: readNumber(attributes.basePrice),
        deliveryCost: readNumber(attributes.deliveryCost),
        weight: readNumber(attributes.weight),
        unitType: readString(attributes.unitType),
        categoryCode: readString(category?.code),
        categoryTitle: readString(category?.title),
        merchantSku: readString(merchantAttributes.code),
        productName: readString(merchantAttributes.name),
        manufacturer: readString(merchantAttributes.manufacturer),
      } satisfies ParsedKaspiItem;
    })
    .filter((item): item is ParsedKaspiItem => !!item && !!item.externalEntryId);
}

function extractCustomerSnapshot(payload: StoredKaspiPayload): Record<string, unknown> | null {
  const attributes = payload.order?.attributes ?? {};
  const customer = isRecord(attributes.customer) ? attributes.customer : null;
  return customer ? { ...customer } : null;
}

function extractDeliverySnapshot(payload: StoredKaspiPayload): Record<string, unknown> | null {
  const attributes = payload.order?.attributes ?? {};
  const deliveryFields = [
    'deliveryMode',
    'deliveryType',
    'plannedDeliveryDate',
    'deliveryCostForSeller',
    'deliveryCost',
    'isKaspiDelivery',
    'reservationDate',
    'pickupPoint',
    'deliveryAddress',
  ] as const;

  const snapshot = Object.fromEntries(
    deliveryFields
      .map((field) => [field, attributes[field]] as const)
      .filter(([, value]) => value !== undefined && value !== null),
  );

  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function extractCustomerName(payload: StoredKaspiPayload): string | null {
  const customer = extractCustomerSnapshot(payload);
  if (!customer) {
    return null;
  }

  const directName = readString(customer.name);
  if (directName) {
    return directName;
  }

  const composedName = [readString(customer.lastName), readString(customer.firstName)]
    .filter((value): value is string => !!value)
    .join(' ')
    .trim();
  return composedName || null;
}

function extractCustomerPhone(payload: StoredKaspiPayload): string | null {
  const customer = extractCustomerSnapshot(payload);
  if (!customer) {
    return null;
  }

  return readString(customer.cellPhone) ?? readString(customer.phone) ?? readString(customer.mobilePhone);
}

async function requireConnection(orgId: string) {
  const connection = await prisma.kaspiConnection.findFirst({
    where: { orgId, isActive: true },
    orderBy: [
      { updatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  if (!connection) {
    throw new NotFoundError('KaspiConnection');
  }

  if (!connection.isActive) {
    throw new ValidationError('Kaspi connection is disabled');
  }

  return connection;
}

async function findCurrentConnection(orgId: string) {
  return prisma.kaspiConnection.findFirst({
    where: { orgId, isActive: true },
    orderBy: [
      { updatedAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });
}

async function requireConnectionById(orgId: string, connectionId: string) {
  const connection = await prisma.kaspiConnection.findFirst({
    where: { orgId, id: connectionId },
  });

  if (!connection) {
    throw new NotFoundError('KaspiConnection', connectionId);
  }

  return connection;
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

  return sites[0] ?? null;
}

async function loadWarehouseMatchContext(orgId: string, merchantSkus: string[], externalOrderIds: string[]): Promise<WarehouseMatchContext> {
  const normalizedSkus = [...new Set(merchantSkus.map((sku) => normalizeSku(sku)).filter(Boolean))];

  const [site, warehouseItems, reservations] = await Promise.all([
    getSingleActiveWarehouseSite(orgId),
    normalizedSkus.length > 0
      ? prisma.warehouseItem.findMany({
          where: {
            orgId,
            sku: { in: merchantSkus },
          },
          select: {
            id: true,
            name: true,
            sku: true,
            productCatalogId: true,
            variantKey: true,
          },
        })
      : Promise.resolve([]),
    externalOrderIds.length > 0
      ? prisma.warehouseStockReservation.findMany({
          where: {
            orgId,
            sourceType: 'kaspi_order',
            sourceId: { in: externalOrderIds },
          },
          select: {
            id: true,
            sourceId: true,
            sourceLineId: true,
            status: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const warehouseItemsBySku = new Map<string, WarehouseItemMatchCandidate[]>();
  for (const item of warehouseItems) {
    const sku = readString(item.sku);
    if (!sku) {
      continue;
    }
    const key = normalizeSku(sku);
    const bucket = warehouseItemsBySku.get(key) ?? [];
    bucket.push(item);
    warehouseItemsBySku.set(key, bucket);
  }

  const variantSelectors = warehouseItems
    .filter((item) => item.productCatalogId && item.variantKey)
    .map((item) => ({
      productCatalogId: item.productCatalogId!,
      variantKey: item.variantKey!,
    }));

  const variants = variantSelectors.length > 0
    ? await prisma.warehouseVariant.findMany({
        where: {
          orgId,
          OR: variantSelectors.map((selector) => ({
            productCatalogId: selector.productCatalogId,
            variantKey: selector.variantKey,
          })),
        },
        select: {
          id: true,
          productCatalogId: true,
          variantKey: true,
        },
      })
    : [];

  const variantsByKey = new Map<string, WarehouseVariantCandidate>();
  for (const variant of variants) {
    variantsByKey.set(variantCompositeKey(variant.productCatalogId, variant.variantKey), variant);
  }

  const reservationsByOrderId = new Map<string, Map<string, StockReservationRecord>>();
  for (const reservation of reservations) {
    if (!reservation.sourceLineId) {
      continue;
    }

    const orderReservations = reservationsByOrderId.get(reservation.sourceId) ?? new Map<string, StockReservationRecord>();
    orderReservations.set(reservation.sourceLineId, reservation);
    reservationsByOrderId.set(reservation.sourceId, orderReservations);
  }

  return {
    site,
    warehouseItemsBySku,
    variantsByKey,
    reservationsByOrderId,
  };
}

function isReleaseStatus(status: string | null) {
  return !!status && KASPI_RELEASE_STATUSES.has(status);
}

function isReservationEligibleStatus(status: string | null) {
  return !!status && KASPI_RESERVATION_STATUSES.has(status);
}

function computeItemStockImpactState(
  externalStatus: string | null,
  hasSite: boolean,
  isMatched: boolean,
  reservationStatus: string | null,
): KaspiStockImpactState {
  if (!isMatched) {
    return 'no_match';
  }

  if (isReleaseStatus(externalStatus)) {
    if (reservationStatus === 'consumed') {
      return 'not_tracked';
    }
    return 'released';
  }

  if (!isReservationEligibleStatus(externalStatus)) {
    return 'pending_acceptance';
  }

  if (!hasSite) {
    return 'no_active_site';
  }

  if (reservationStatus === 'active' || reservationStatus === 'consumed') {
    return 'reserved';
  }

  if (reservationStatus === 'released') {
    return 'released';
  }

  return 'pending_reservation';
}

function buildMatchedItems(
  row: KaspiOrderLinkRecord,
  payload: StoredKaspiPayload,
  context: WarehouseMatchContext,
): { matchedItems: KaspiOrderItemView[]; unmatchedItems: KaspiOrderItemView[] } {
  const items = parseKaspiItems(payload);
  const reservations = context.reservationsByOrderId.get(row.externalOrderId) ?? new Map<string, StockReservationRecord>();
  const matchedItems: KaspiOrderItemView[] = [];
  const unmatchedItems: KaspiOrderItemView[] = [];

  for (const item of items) {
    const sku = readString(item.merchantSku);
    const normalizedSku = sku ? normalizeSku(sku) : null;
    const candidates = normalizedSku ? (context.warehouseItemsBySku.get(normalizedSku) ?? []) : [];
    const reservation = reservations.get(item.externalEntryId) ?? null;

    let matchReason: string | null = null;
    let warehouseItem: WarehouseItemMatchCandidate | null = null;
    let variantId: string | null = null;

    if (!sku) {
      matchReason = 'external_sku_missing';
    } else if (candidates.length === 0) {
      matchReason = 'warehouse_sku_not_found';
    } else if (candidates.length > 1) {
      matchReason = 'warehouse_sku_ambiguous';
    } else {
      warehouseItem = candidates[0]!;
      if (!warehouseItem.productCatalogId || !warehouseItem.variantKey) {
        matchReason = 'warehouse_item_not_canonical';
      } else {
        const variant = context.variantsByKey.get(
          variantCompositeKey(warehouseItem.productCatalogId, warehouseItem.variantKey),
        );
        if (!variant) {
          matchReason = 'warehouse_variant_not_found';
        } else {
          variantId = variant.id;
        }
      }
    }

    const isMatched = !!warehouseItem && !!variantId && !matchReason;
    const viewItem: KaspiOrderItemView = {
      externalEntryId: item.externalEntryId,
      entryNumber: item.entryNumber,
      quantity: item.quantity,
      totalPrice: item.totalPrice,
      basePrice: item.basePrice,
      deliveryCost: item.deliveryCost,
      weight: item.weight,
      unitType: item.unitType,
      categoryCode: item.categoryCode,
      categoryTitle: item.categoryTitle,
      merchantSku: item.merchantSku,
      productName: item.productName,
      manufacturer: item.manufacturer,
      matchState: isMatched ? 'matched' : 'unmatched',
      matchReason,
      stockImpactState: computeItemStockImpactState(
        row.externalStatus,
        !!context.site,
        isMatched,
        reservation?.status ?? null,
      ),
      warehouseItemId: warehouseItem?.id ?? null,
      warehouseItemName: warehouseItem?.name ?? null,
      warehouseSku: warehouseItem?.sku ?? null,
      warehouseVariantId: variantId,
      reservationId: reservation?.id ?? null,
      reservationStatus: reservation?.status ?? null,
    };

    if (isMatched) {
      matchedItems.push(viewItem);
    } else {
      unmatchedItems.push(viewItem);
    }
  }

  return { matchedItems, unmatchedItems };
}

function computeOrderMatchState(matchedItems: KaspiOrderItemView[], unmatchedItems: KaspiOrderItemView[]) {
  if (matchedItems.length === 0 && unmatchedItems.length === 0) {
    return 'no_items' as const;
  }
  if (matchedItems.length > 0 && unmatchedItems.length === 0) {
    return 'matched' as const;
  }
  if (matchedItems.length > 0 && unmatchedItems.length > 0) {
    return 'partial' as const;
  }
  return 'unmatched' as const;
}

function computeOrderStockImpactState(
  row: KaspiOrderLinkRecord,
  matchedItems: KaspiOrderItemView[],
  unmatchedItems: KaspiOrderItemView[],
  hasSite: boolean,
): KaspiStockImpactState {
  if (matchedItems.length === 0) {
    return 'no_match';
  }

  if (isReleaseStatus(row.externalStatus)) {
    if (matchedItems.some((item) => item.stockImpactState === 'not_tracked')) {
      return 'not_tracked';
    }
    return 'released';
  }

  if (!isReservationEligibleStatus(row.externalStatus)) {
    return 'pending_acceptance';
  }

  if (!hasSite) {
    return 'no_active_site';
  }

  const reservedCount = matchedItems.filter((item) => item.reservationStatus === 'active' || item.reservationStatus === 'consumed').length;
  if (reservedCount === matchedItems.length && unmatchedItems.length === 0) {
    return 'reserved';
  }

  if (reservedCount > 0) {
    return 'partial_reserved';
  }

  return 'pending_reservation';
}

function buildStatusHistory(row: KaspiOrderLinkRecord, payload: StoredKaspiPayload) {
  const attributes = payload.order?.attributes ?? {};
  return [
    { key: 'creation', label: '\u0421\u043e\u0437\u0434\u0430\u043d', at: readTimestampIso(attributes.creationDate) },
    { key: 'approved', label: '\u041e\u0434\u043e\u0431\u0440\u0435\u043d \u0431\u0430\u043d\u043a\u043e\u043c', at: readTimestampIso(attributes.approvedByBankDate) },
    { key: 'accepted', label: '\u041f\u0440\u0438\u043d\u044f\u0442 \u043f\u0440\u043e\u0434\u0430\u0432\u0446\u043e\u043c', at: toIso(row.acceptedAt) },
    { key: 'completed', label: '\u0417\u0430\u0432\u0435\u0440\u0448\u0451\u043d', at: toIso(row.completedAt) },
    { key: 'cancelled', label: '\u041e\u0442\u043c\u0435\u043d\u0451\u043d / \u0432\u043e\u0437\u0432\u0440\u0430\u0449\u0451\u043d', at: toIso(row.cancelledAt) },
  ];
}

function buildKaspiSyncWindows(lastSyncAt: Date | null) {
  const now = Date.now();
  const lookbackStart = now - (KASPI_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const resumedStart = lastSyncAt
    ? Math.max(lookbackStart, lastSyncAt.getTime() - (24 * 60 * 60 * 1000))
    : lookbackStart;

  const windows: Array<{ fromMs: number; toMs: number }> = [];
  let cursor = resumedStart;

  while (cursor <= now) {
    const end = Math.min(
      now,
      cursor + (KASPI_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000) - 1,
    );
    windows.push({ fromMs: cursor, toMs: end });
    cursor = end + 1;
  }

  return windows;
}

function buildOrderView(
  row: KaspiOrderLinkRecord,
  payload: StoredKaspiPayload,
  context: WarehouseMatchContext,
): BuiltKaspiOrderView {
  const attributes = payload.order?.attributes ?? {};
  const { matchedItems, unmatchedItems } = buildMatchedItems(row, payload, context);
  const customerSnapshot = extractCustomerSnapshot(payload);
  const deliverySnapshot = extractDeliverySnapshot(payload);

  const view: KaspiOrderView = {
    id: row.id,
    orgId: row.orgId,
    connectionId: row.connectionId,
    externalOrderId: row.externalOrderId,
    externalOrderCode: row.externalOrderCode,
    externalState: row.externalState,
    externalStatus: row.externalStatus,
    deliveryMode: row.externalDeliveryMode ?? readString(attributes.deliveryMode),
    totalPrice: readNumber(attributes.totalPrice),
    paymentMode: readString(attributes.paymentMode),
    customerName: extractCustomerName(payload),
    customerPhone: extractCustomerPhone(payload),
    plannedDeliveryDate: readTimestampIso(attributes.plannedDeliveryDate),
    creationDate: readTimestampIso(attributes.creationDate),
    approvedByBankDate: readTimestampIso(attributes.approvedByBankDate),
    acceptedAt: toIso(row.acceptedAt),
    completedAt: toIso(row.completedAt),
    cancelledAt: toIso(row.cancelledAt),
    internalOrderId: row.internalOrderId,
    internalOrderType: row.internalOrderType,
    matchState: computeOrderMatchState(matchedItems, unmatchedItems),
    stockImpactState: computeOrderStockImpactState(row, matchedItems, unmatchedItems, !!context.site),
    matchedItems,
    unmatchedItems,
    lastExternalUpdateAt: toIso(row.lastExternalUpdateAt),
    lastSyncedAt: toIso(row.lastSyncedAt),
    syncError: row.syncError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  return {
    view,
    customerSnapshot,
    deliverySnapshot,
    rawPayloadPresent: !!payload.order || payload.entries.length > 0,
  };
}

async function buildKaspiOrderViews(rows: KaspiOrderLinkRecord[]): Promise<BuiltKaspiOrderView[]> {
  if (rows.length === 0) {
    return [];
  }

  const payloads = rows.map((row) => parseStoredPayload(row.rawPayload));
  const merchantSkus = payloads
    .flatMap((payload) => parseKaspiItems(payload))
    .map((item) => item.merchantSku)
    .filter((value): value is string => !!value);

  const context = await loadWarehouseMatchContext(
    rows[0]!.orgId,
    merchantSkus,
    rows.map((row) => row.externalOrderId),
  );

  return rows.map((row, index) => buildOrderView(row, payloads[index]!, context));
}

function summarizeOrderView(view: KaspiOrderView, summary: KaspiOrdersSummaryView) {
  summary.total += 1;

  if (view.externalStatus === 'APPROVED_BY_BANK') {
    summary.newOrNeedsAcceptance += 1;
  } else if (view.externalStatus === 'ACCEPTED_BY_MERCHANT') {
    if (view.externalState && ['PICKUP', 'DELIVERY', 'KASPI_DELIVERY', 'ARCHIVE'].includes(view.externalState)) {
      summary.handoffOrDeliveryInProgress += 1;
    } else {
      summary.accepted += 1;
    }
  } else if (view.externalStatus === 'COMPLETED') {
    summary.completed += 1;
  } else if (view.externalStatus && KASPI_CANCELLATION_STATUSES.has(view.externalStatus)) {
    summary.cancelledOrReturned += 1;
  }

  const hasIssues =
    !!view.syncError
    || view.matchState !== 'matched'
    || !['pending_acceptance', 'reserved', 'released'].includes(view.stockImpactState);
  if (hasIssues) {
    summary.unmatchedOrStockIssues += 1;
  }
}

async function upsertOrderLink(
  orgId: string,
  connectionId: string,
  order: KaspiHydratedOrder,
  syncError?: string | null,
) {
  const externalTimestamp = coerceExternalTimestamp(order.summary.updatedAt);
  const existing = await prisma.kaspiOrderLink.findUnique({
    where: {
      connectionId_externalOrderId: {
        connectionId,
        externalOrderId: order.summary.id,
      },
    },
    select: {
      acceptedAt: true,
      completedAt: true,
      cancelledAt: true,
    },
  });

  const acceptedAt = existing?.acceptedAt
    ?? (order.summary.status === 'ACCEPTED_BY_MERCHANT' ? externalTimestamp : null);
  const completedAt = existing?.completedAt
    ?? (order.summary.status === 'COMPLETED' ? externalTimestamp : null);
  const cancelledAt = existing?.cancelledAt
    ?? (isReleaseStatus(order.summary.status) ? externalTimestamp : null);

  return prisma.kaspiOrderLink.upsert({
    where: {
      connectionId_externalOrderId: {
        connectionId,
        externalOrderId: order.summary.id,
      },
    },
    create: {
      orgId,
      connectionId,
      externalOrderId: order.summary.id,
      externalOrderCode: order.summary.code,
      externalState: order.summary.state,
      externalStatus: order.summary.status,
      externalDeliveryMode: order.summary.deliveryMode,
      rawPayload: order.payload as unknown as Prisma.InputJsonValue,
      lastExternalUpdateAt: externalTimestamp,
      acceptedAt,
      completedAt,
      cancelledAt,
      lastSyncedAt: new Date(),
      syncError: syncError ?? null,
    },
    update: {
      connectionId,
      externalOrderCode: order.summary.code,
      externalState: order.summary.state,
      externalStatus: order.summary.status,
      externalDeliveryMode: order.summary.deliveryMode,
      rawPayload: order.payload as unknown as Prisma.InputJsonValue,
      lastExternalUpdateAt: externalTimestamp,
      acceptedAt,
      completedAt,
      cancelledAt,
      lastSyncedAt: new Date(),
      syncError: syncError ?? null,
    },
  });
}

async function listOrdersForKaspiWindow(
  apiToken: string,
  params: {
    pageSize: number;
    creationDateFromMs: number;
    creationDateToMs: number;
  },
) {
  const summaries: KaspiOrderSummary[] = [];
  let fetchedPages = 0;

  for (let pageNumber = 0; pageNumber < KASPI_SYNC_MAX_PAGES_PER_WINDOW; pageNumber += 1) {
    const page = await listKaspiOrders(apiToken, {
      pageNumber,
      pageSize: params.pageSize,
      creationDateFromMs: params.creationDateFromMs,
      creationDateToMs: params.creationDateToMs,
    });

    fetchedPages += 1;
    summaries.push(...page);

    if (page.length < params.pageSize) {
      return { summaries, fetchedPages };
    }
  }

  throw new ValidationError(
    `Kaspi sync window exceeded ${KASPI_SYNC_MAX_PAGES_PER_WINDOW} pages. Narrow the sync range or raise the cap.`,
  );
}

function assertKaspiCompletionWriteEnabled() {
  if (!KASPI_COMPLETION_WRITE_ENABLED) {
    throw new ValidationError('Kaspi completion control is disabled in read-only mode');
  }
}

function createEmptyKaspiSummary(): KaspiOrdersSummaryView {
  return {
    total: 0,
    newOrNeedsAcceptance: 0,
    accepted: 0,
    handoffOrDeliveryInProgress: 0,
    completed: 0,
    cancelledOrReturned: 0,
    unmatchedOrStockIssues: 0,
  };
}

function safeWorksheetName(input: string) {
  const cleaned = input.replace(/[\\/*?:[\]]/g, ' ').trim();
  return (cleaned || 'Kaspi Orders').slice(0, 31);
}

function safeFilePart(input: string) {
  return input.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'kaspi';
}

async function syncKaspiOrderStock(orgId: string, row: KaspiOrderLinkRecord) {
  const payload = parseStoredPayload(row.rawPayload);
  const parsedItems = parseKaspiItems(payload);
  const merchantSkus = parsedItems
    .map((item) => item.merchantSku)
    .filter((value): value is string => !!value);
  const context = await loadWarehouseMatchContext(orgId, merchantSkus, [row.externalOrderId]);
  const { matchedItems } = buildMatchedItems(row, payload, context);

  if (isReleaseStatus(row.externalStatus)) {
    const activeReservations = await prisma.warehouseStockReservation.findMany({
      where: {
        orgId,
        sourceType: 'kaspi_order',
        sourceId: row.externalOrderId,
        status: 'active',
      },
      select: { id: true },
    });

    if (activeReservations.length === 0) {
      return;
    }

    await prisma.$transaction(async (tx) => {
      for (const reservation of activeReservations) {
        await releaseStockReservationInTx(
          tx,
          orgId,
          reservation.id,
          'kaspi_sync',
          `Kaspi release for ${row.externalOrderCode ?? row.externalOrderId}`,
        );
      }
    });
    return;
  }

  if (!isReservationEligibleStatus(row.externalStatus) || !context.site) {
    return;
  }

  for (const item of matchedItems) {
    if (!item.warehouseVariantId || !item.quantity || item.quantity <= 0) {
      continue;
    }

    if (item.reservationStatus === 'active' || item.reservationStatus === 'consumed') {
      continue;
    }

    try {
      await createStockReservation(orgId, {
        warehouseSiteId: context.site.id,
        variantId: item.warehouseVariantId,
        qty: item.quantity,
        sourceType: 'kaspi_order',
        sourceId: row.externalOrderId,
        sourceLineId: item.externalEntryId,
        idempotencyKey: `kaspi-order:${row.externalOrderId}:${item.externalEntryId}:reserve:v1`,
        actorName: 'kaspi_sync',
        reason: `Kaspi reservation for ${row.externalOrderCode ?? row.externalOrderId}`,
      });
    } catch {
      // Keep sync resilient. The list/detail read model surfaces this as pending_reservation.
    }
  }

  if (row.externalStatus !== 'COMPLETED') {
    return;
  }

  const activeReservations = await prisma.warehouseStockReservation.findMany({
    where: {
      orgId,
      sourceType: 'kaspi_order',
      sourceId: row.externalOrderId,
      status: 'active',
    },
    select: { id: true },
  });

  if (activeReservations.length === 0) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const reservation of activeReservations) {
      await consumeStockReservationInTx(
        tx,
        orgId,
        reservation.id,
        'kaspi_sync',
        `Kaspi completion consume for ${row.externalOrderCode ?? row.externalOrderId}`,
      );
    }
  });
}

async function requireOrderLink(orgId: string, externalOrderId: string) {
  const currentConnection = await findCurrentConnection(orgId);
  if (!currentConnection) {
    throw new NotFoundError('KaspiConnection');
  }

  const link = await prisma.kaspiOrderLink.findUnique({
    where: {
      connectionId_externalOrderId: {
        connectionId: currentConnection.id,
        externalOrderId,
      },
    },
    include: {
      connection: true,
    },
  });

  if (!link) {
    throw new NotFoundError('KaspiOrderLink', externalOrderId);
  }

  if (!link.externalOrderCode) {
    throw new ValidationError('Kaspi order code is missing. Run sync before completing the order.');
  }

  if (!link.connection.isActive) {
    throw new ValidationError('Kaspi connection is disabled');
  }

  return link;
}

export async function getConnection(orgId: string): Promise<KaspiConnectionView | null> {
  const record = await findCurrentConnection(orgId);

  return record ? mapConnection(record) : null;
}

export async function listConnections(orgId: string): Promise<KaspiConnectionHistoryItemView[]> {
  const [connections, stats] = await Promise.all([
    prisma.kaspiConnection.findMany({
      where: { orgId },
      orderBy: [
        { isActive: 'desc' },
        { updatedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    }),
    prisma.kaspiOrderLink.groupBy({
      by: ['connectionId', 'externalStatus'],
      where: { orgId },
      _count: { _all: true },
      _max: { lastExternalUpdateAt: true },
    }),
  ]);

  const bucket = new Map<string, {
    ordersCount: number;
    completedOrdersCount: number;
    cancelledOrdersCount: number;
    lastOrderUpdateAt: Date | null;
  }>();

  for (const row of stats) {
    const current = bucket.get(row.connectionId) ?? {
      ordersCount: 0,
      completedOrdersCount: 0,
      cancelledOrdersCount: 0,
      lastOrderUpdateAt: null,
    };
    current.ordersCount += row._count._all;
    if (row.externalStatus === 'COMPLETED') {
      current.completedOrdersCount += row._count._all;
    }
    if (row.externalStatus && KASPI_CANCELLATION_STATUSES.has(row.externalStatus)) {
      current.cancelledOrdersCount += row._count._all;
    }
    if (!current.lastOrderUpdateAt || (row._max.lastExternalUpdateAt && row._max.lastExternalUpdateAt > current.lastOrderUpdateAt)) {
      current.lastOrderUpdateAt = row._max.lastExternalUpdateAt ?? current.lastOrderUpdateAt;
    }
    bucket.set(row.connectionId, current);
  }

  return connections.map((connection) => {
    const item = bucket.get(connection.id);
    return {
      ...mapConnection(connection),
      ordersCount: item?.ordersCount ?? 0,
      completedOrdersCount: item?.completedOrdersCount ?? 0,
      cancelledOrdersCount: item?.cancelledOrdersCount ?? 0,
      lastOrderUpdateAt: toIso(item?.lastOrderUpdateAt ?? null),
    };
  });
}

export async function disconnectConnection(orgId: string): Promise<KaspiConnectionView | null> {
  const current = await findCurrentConnection(orgId);
  if (!current) {
    return null;
  }

  const record = await prisma.kaspiConnection.update({
    where: { id: current.id },
    data: {
      isActive: false,
      archivedAt: new Date(),
    },
  });

  return mapConnection(record);
}

export async function saveConnection(orgId: string, input: SaveKaspiConnectionInput): Promise<KaspiConnectionView> {
  const existing = await findCurrentConnection(orgId);
  const trimmedToken = input.apiToken?.trim();

  if (!existing && !trimmedToken) {
    throw new ValidationError('Kaspi API token is required');
  }

  const sellerName =
    input.sellerName !== undefined
      ? (input.sellerName.trim() || null)
      : (existing?.sellerName ?? null);

  if (!existing) {
    const apiToken = trimmedToken!;
    const record = await prisma.kaspiConnection.create({
      data: {
        orgId,
        sellerName,
        apiToken,
        tokenLast4: apiToken.slice(-4).padStart(4, '*'),
        isActive: input.isActive ?? true,
      },
    });
    return mapConnection(record);
  }

  if (!trimmedToken || trimmedToken === existing.apiToken) {
    const record = await prisma.kaspiConnection.update({
      where: { id: existing.id },
      data: {
        sellerName,
        isActive: input.isActive ?? true,
        lastSyncError: null,
      },
    });
    return mapConnection(record);
  }

  const record = await prisma.$transaction(async (tx) => {
    await tx.kaspiConnection.update({
      where: { id: existing.id },
      data: {
        isActive: false,
        archivedAt: new Date(),
      },
    });

    return tx.kaspiConnection.create({
      data: {
        orgId,
        sellerName,
        apiToken: trimmedToken,
        tokenLast4: trimmedToken.slice(-4).padStart(4, '*'),
        isActive: true,
      },
    });
  });

  return mapConnection(record);
}

export async function testConnection(orgId: string) {
  const connection = await requireConnection(orgId);
  const startedAt = new Date();

  try {
    const orders = await listKaspiOrders(connection.apiToken, { pageNumber: 0, pageSize: 1 });
    await prisma.kaspiConnection.update({
      where: { id: connection.id },
      data: {
        lastCheckedAt: startedAt,
        lastSyncError: null,
      },
    });

    return {
      ok: true as const,
      checkedAt: startedAt.toISOString(),
      sampleOrders: orders.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Kaspi connection test failed';
    await prisma.kaspiConnection.update({
      where: { id: connection.id },
      data: {
        lastCheckedAt: startedAt,
        lastSyncError: message,
      },
    });
    throw error;
  }
}

export async function syncOrders(orgId: string): Promise<SyncKaspiOrdersResult> {
  const connection = await requireConnection(orgId);
  const pageSize = 100;
  const summaries: KaspiOrderSummary[] = [];
  const summaryById = new Map<string, KaspiOrderSummary>();
  const windows = buildKaspiSyncWindows(connection.lastSyncAt);
  let fetchedPages = 0;

  for (const window of windows) {
    const result = await listOrdersForKaspiWindow(connection.apiToken, {
      pageSize,
      creationDateFromMs: window.fromMs,
      creationDateToMs: window.toMs,
    });
    fetchedPages += result.fetchedPages;

    for (const order of result.summaries) {
      if (!summaryById.has(order.id)) {
        summaryById.set(order.id, order);
        summaries.push(order);
      }
    }
  }

  let upserted = 0;
  const failures: string[] = [];

  for (const summary of summaries) {
    try {
      const hydratedOrder = await hydrateKaspiOrder(connection.apiToken, summary);
      const link = await upsertOrderLink(orgId, connection.id, hydratedOrder);
      await syncKaspiOrderStock(orgId, link as KaspiOrderLinkRecord);
      upserted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Kaspi order sync failed';
      failures.push(`${summary.id}: ${message}`);

      try {
        await upsertOrderLink(orgId, connection.id, {
          summary,
          payload: {
            order: summary.raw,
            entries: [],
          },
        }, message);
      } catch {
        // Keep the parent sync resilient even if the fallback upsert also fails.
      }
    }
  }

  const syncedAt = new Date();
  await prisma.kaspiConnection.update({
    where: { id: connection.id },
    data: {
      lastCheckedAt: syncedAt,
      lastSyncAt: syncedAt,
      lastSyncError: failures.length > 0 ? `${failures.length} order(s) failed during sync` : null,
    },
  });

  return {
    fetched: summaries.length,
    upserted,
    fetchedPages,
    syncedAt: syncedAt.toISOString(),
  };
}

export async function listOrders(orgId: string, filters: ListKaspiOrdersInput = {}) {
  const currentConnection = await findCurrentConnection(orgId);
  if (!currentConnection) {
    return {
      count: 0,
      results: [],
    };
  }

  const where = {
    orgId,
    connectionId: currentConnection.id,
    ...(filters.state ? { externalState: filters.state } : {}),
    ...(filters.status ? { externalStatus: filters.status } : {}),
  };
  const [rows, totalCount] = await Promise.all([
    prisma.kaspiOrderLink.findMany({
      where,
      orderBy: [
        { lastExternalUpdateAt: 'desc' },
        { updatedAt: 'desc' },
      ],
      skip: filters.offset ?? 0,
      take: filters.limit ?? 50,
      select: {
        id: true,
        orgId: true,
        connectionId: true,
        externalOrderId: true,
        externalOrderCode: true,
        externalState: true,
        externalStatus: true,
        externalDeliveryMode: true,
        internalOrderId: true,
        internalOrderType: true,
        rawPayload: true,
        lastExternalUpdateAt: true,
        acceptedAt: true,
        completedAt: true,
        cancelledAt: true,
        lastSyncedAt: true,
        syncError: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.kaspiOrderLink.count({ where }),
  ]);

  const built = await buildKaspiOrderViews(rows);

  return {
    count: totalCount,
    results: built.map((item) => item.view),
  };
}

export async function getOrderDetail(orgId: string, externalOrderId: string): Promise<KaspiOrderDetailView> {
  const currentConnection = await findCurrentConnection(orgId);
  if (!currentConnection) {
    throw new NotFoundError('KaspiConnection');
  }

  const row = await prisma.kaspiOrderLink.findUnique({
    where: {
      connectionId_externalOrderId: {
        connectionId: currentConnection.id,
        externalOrderId,
      },
    },
    select: {
      id: true,
      orgId: true,
      connectionId: true,
      externalOrderId: true,
      externalOrderCode: true,
      externalState: true,
      externalStatus: true,
      externalDeliveryMode: true,
      internalOrderId: true,
      internalOrderType: true,
      rawPayload: true,
      lastExternalUpdateAt: true,
      acceptedAt: true,
      completedAt: true,
      cancelledAt: true,
      lastSyncedAt: true,
      syncError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!row) {
    throw new NotFoundError('KaspiOrderLink', externalOrderId);
  }

  const payload = parseStoredPayload(row.rawPayload);
  const built = (await buildKaspiOrderViews([row]))[0]!;

  return {
    ...built.view,
    statusHistory: buildStatusHistory(row, payload),
    deliverySnapshot: built.deliverySnapshot,
    customerSnapshot: built.customerSnapshot,
    syncDiagnostics: {
      lastExternalUpdateAt: built.view.lastExternalUpdateAt,
      lastSyncedAt: built.view.lastSyncedAt,
      syncError: built.view.syncError,
      rawPayloadPresent: built.rawPayloadPresent,
    },
  };
}

export async function getOrdersSummary(orgId: string): Promise<KaspiOrdersSummaryView> {
  const currentConnection = await findCurrentConnection(orgId);
  if (!currentConnection) {
    return createEmptyKaspiSummary();
  }

  const rows = await prisma.kaspiOrderLink.findMany({
    where: { orgId, connectionId: currentConnection.id },
    orderBy: [
      { lastExternalUpdateAt: 'desc' },
      { updatedAt: 'desc' },
    ],
    select: {
      id: true,
      orgId: true,
      connectionId: true,
      externalOrderId: true,
      externalOrderCode: true,
      externalState: true,
      externalStatus: true,
      externalDeliveryMode: true,
      internalOrderId: true,
      internalOrderType: true,
      rawPayload: true,
      lastExternalUpdateAt: true,
      acceptedAt: true,
      completedAt: true,
      cancelledAt: true,
      lastSyncedAt: true,
      syncError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const built = await buildKaspiOrderViews(rows);
  const summary: KaspiOrdersSummaryView = createEmptyKaspiSummary();

  for (const item of built) {
    summarizeOrderView(item.view, summary);
  }

  return summary;
}

export async function exportConnectionOrders(orgId: string, connectionId: string): Promise<KaspiExportResult> {
  const connection = await requireConnectionById(orgId, connectionId);
  const rows = await prisma.kaspiOrderLink.findMany({
    where: { orgId, connectionId },
    orderBy: [
      { lastExternalUpdateAt: 'desc' },
      { updatedAt: 'desc' },
    ],
    select: {
      id: true,
      orgId: true,
      connectionId: true,
      externalOrderId: true,
      externalOrderCode: true,
      externalState: true,
      externalStatus: true,
      externalDeliveryMode: true,
      internalOrderId: true,
      internalOrderType: true,
      rawPayload: true,
      lastExternalUpdateAt: true,
      acceptedAt: true,
      completedAt: true,
      cancelledAt: true,
      lastSyncedAt: true,
      syncError: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const built = await buildKaspiOrderViews(rows);
  const workbook = new ExcelJS.Workbook();
  const now = new Date();
  workbook.creator = 'KORT';
  workbook.lastModifiedBy = 'KORT';
  workbook.created = now;
  workbook.modified = now;
  workbook.title = 'Kaspi Orders Export';
  workbook.subject = 'Kaspi order archive';

  const ordersSheet = workbook.addWorksheet(safeWorksheetName('\u0417\u0430\u043a\u0430\u0437\u044b Kaspi'));
  ordersSheet.views = [{ state: 'frozen', ySplit: 4 }];
  ordersSheet.columns = [
    { key: 'code', width: 18 },
    { key: 'externalId', width: 24 },
    { key: 'status', width: 20 },
    { key: 'state', width: 18 },
    { key: 'customer', width: 26 },
    { key: 'phone', width: 18 },
    { key: 'total', width: 14 },
    { key: 'matchState', width: 14 },
    { key: 'stockImpact', width: 18 },
    { key: 'updatedAt', width: 22 },
    { key: 'syncError', width: 36 },
  ];

  ordersSheet.mergeCells('A1:K1');
  ordersSheet.getCell('A1').value = '\u0410\u0440\u0445\u0438\u0432 \u0437\u0430\u043a\u0430\u0437\u043e\u0432 Kaspi';
  ordersSheet.getCell('A1').font = { bold: true, size: 15 };
  ordersSheet.getCell('A1').alignment = { horizontal: 'center' };

  ordersSheet.mergeCells('A2:K2');
  ordersSheet.getCell('A2').value = [
    connection.sellerName || 'Kaspi store',
    connection.isActive ? '\u0442\u0435\u043a\u0443\u0449\u0438\u0439' : '\u0430\u0440\u0445\u0438\u0432',
    now.toLocaleDateString('ru-KZ'),
  ].join(' - ');
  ordersSheet.getCell('A2').alignment = { horizontal: 'center' };
  ordersSheet.getCell('A2').font = { color: { argb: 'FF666666' } };

  ordersSheet.addRow([]);
  const ordersHeader = ordersSheet.addRow([
    '\u041a\u043e\u0434',
    'External ID',
    'Status',
    'State',
    '\u041a\u043b\u0438\u0435\u043d\u0442',
    '\u0422\u0435\u043b\u0435\u0444\u043e\u043d',
    '\u0421\u0443\u043c\u043c\u0430',
    'Match',
    'Stock',
    '\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u043e',
    'Sync error',
  ]);
  ordersHeader.font = { bold: true };
  ordersHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
  ordersHeader.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ordersSheet.autoFilter = {
    from: 'A4',
    to: 'K4',
  };

  for (const item of built) {
    const row = ordersSheet.addRow([
      item.view.externalOrderCode || '',
      item.view.externalOrderId,
      item.view.externalStatus || '',
      item.view.externalState || '',
      item.view.customerName || '',
      item.view.customerPhone || '',
      item.view.totalPrice ?? null,
      item.view.matchState,
      item.view.stockImpactState,
      item.view.lastExternalUpdateAt ? new Date(item.view.lastExternalUpdateAt).toLocaleString('ru-KZ') : '',
      item.view.syncError || '',
    ]);
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
      cell.alignment = { vertical: 'middle' };
    });
    ordersSheet.getCell(`G${row.number}`).numFmt = '#,##0 "\u20B8"';
  }

  const itemsSheet = workbook.addWorksheet(safeWorksheetName('\u041f\u043e\u0437\u0438\u0446\u0438\u0438 Kaspi'));
  itemsSheet.views = [{ state: 'frozen', ySplit: 1 }];
  itemsSheet.columns = [
    { key: 'orderCode', width: 18 },
    { key: 'externalId', width: 24 },
    { key: 'entry', width: 10 },
    { key: 'product', width: 34 },
    { key: 'merchantSku', width: 18 },
    { key: 'warehouseSku', width: 18 },
    { key: 'quantity', width: 12 },
    { key: 'total', width: 14 },
    { key: 'matchState', width: 14 },
    { key: 'matchReason', width: 24 },
    { key: 'stockImpact', width: 18 },
    { key: 'reservation', width: 16 },
  ];

  const itemsHeader = itemsSheet.addRow([
    '\u0417\u0430\u043a\u0430\u0437',
    'External ID',
    '\u041f\u043e\u0437.',
    '\u0422\u043e\u0432\u0430\u0440',
    'Kaspi SKU',
    'Warehouse SKU',
    '\u041a\u043e\u043b-\u0432\u043e',
    '\u0421\u0443\u043c\u043c\u0430',
    'Match',
    '\u041f\u0440\u0438\u0447\u0438\u043d\u0430',
    'Stock',
    'Reservation',
  ]);
  itemsHeader.font = { bold: true };
  itemsHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
  itemsHeader.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  itemsSheet.autoFilter = {
    from: 'A1',
    to: 'L1',
  };

  for (const item of built) {
    for (const line of [...item.view.matchedItems, ...item.view.unmatchedItems]) {
      const row = itemsSheet.addRow([
        item.view.externalOrderCode || '',
        item.view.externalOrderId,
        line.entryNumber ?? null,
        line.productName || '',
        line.merchantSku || '',
        line.warehouseSku || '',
        line.quantity ?? null,
        line.totalPrice ?? null,
        line.matchState,
        line.matchReason || '',
        line.stockImpactState,
        line.reservationStatus || '',
      ]);
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          bottom: { style: 'thin' },
          left: { style: 'thin' },
          right: { style: 'thin' },
        };
        cell.alignment = { vertical: 'middle' };
      });
      itemsSheet.getCell(`H${row.number}`).numFmt = '#,##0 "\u20B8"';
    }
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const storePart = safeFilePart(connection.sellerName || 'kaspi_store');
  const tokenPart = safeFilePart(connection.tokenLast4 || 'token');
  const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const statusPart = connection.isActive ? 'current' : 'archive';

  return {
    buffer,
    filename: `kaspi_orders_${storePart}_${statusPart}_${tokenPart}_${datePart}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

export async function sendCompletionCode(orgId: string, externalOrderId: string): Promise<SendCompletionCodeResult> {
  assertKaspiCompletionWriteEnabled();
  const link = await requireOrderLink(orgId, externalOrderId);
  const result = await sendKaspiCompletionCode(link.connection.apiToken, link.externalOrderId, link.externalOrderCode!);
  await upsertOrderLink(orgId, link.connectionId, {
    summary: result,
    payload: {
      order: result.raw,
      entries: [],
    },
  });

  return {
    externalOrderId: result.id,
    externalOrderCode: result.code ?? link.externalOrderCode!,
    status: result.status,
    state: result.state,
    codeSent: true,
  };
}

export async function confirmCompletionCode(
  orgId: string,
  externalOrderId: string,
  input: ConfirmCompletionCodeInput,
): Promise<ConfirmCompletionCodeResult> {
  assertKaspiCompletionWriteEnabled();
  const securityCode = input.securityCode.trim();
  if (!securityCode) {
    throw new ValidationError('Security code is required');
  }

  const link = await requireOrderLink(orgId, externalOrderId);
  const result = await confirmKaspiCompletedOrder(
    link.connection.apiToken,
    link.externalOrderId,
    link.externalOrderCode!,
    securityCode,
  );
  await upsertOrderLink(orgId, link.connectionId, {
    summary: result,
    payload: {
      order: result.raw,
      entries: [],
    },
  });

  return {
    externalOrderId: result.id,
    externalOrderCode: result.code ?? link.externalOrderCode!,
    status: result.status,
    state: result.state,
    completed: result.status === 'COMPLETED',
  };
}
