export type KaspiOrderMatchState = 'matched' | 'partial' | 'unmatched' | 'no_items';

export type KaspiStockImpactState =
  | 'pending_acceptance'
  | 'reserved'
  | 'partial_reserved'
  | 'pending_reservation'
  | 'released'
  | 'no_match'
  | 'no_active_site'
  | 'not_tracked';

export interface KaspiConnectionView {
  id: string;
  orgId: string;
  sellerName: string | null;
  tokenMasked: string;
  isActive: boolean;
  archivedAt: string | null;
  lastCheckedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KaspiConnectionHistoryItemView extends KaspiConnectionView {
  ordersCount: number;
  completedOrdersCount: number;
  cancelledOrdersCount: number;
  lastOrderUpdateAt: string | null;
}

export interface KaspiOrderItemView {
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
  matchState: 'matched' | 'unmatched';
  matchReason: string | null;
  stockImpactState: KaspiStockImpactState;
  warehouseItemId: string | null;
  warehouseItemName: string | null;
  warehouseSku: string | null;
  warehouseVariantId: string | null;
  reservationId: string | null;
  reservationStatus: string | null;
}

export interface KaspiOrderView {
  id: string;
  orgId: string;
  connectionId: string;
  externalOrderId: string;
  externalOrderCode: string | null;
  externalState: string | null;
  externalStatus: string | null;
  deliveryMode: string | null;
  totalPrice: number | null;
  paymentMode: string | null;
  customerName: string | null;
  customerPhone: string | null;
  plannedDeliveryDate: string | null;
  creationDate: string | null;
  approvedByBankDate: string | null;
  acceptedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  internalOrderId: string | null;
  internalOrderType: string | null;
  matchState: KaspiOrderMatchState;
  stockImpactState: KaspiStockImpactState;
  matchedItems: KaspiOrderItemView[];
  unmatchedItems: KaspiOrderItemView[];
  lastExternalUpdateAt: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KaspiOrderDetailView extends KaspiOrderView {
  statusHistory: Array<{
    key: string;
    label: string;
    at: string | null;
  }>;
  deliverySnapshot: Record<string, unknown> | null;
  customerSnapshot: Record<string, unknown> | null;
  syncDiagnostics: {
    lastExternalUpdateAt: string | null;
    lastSyncedAt: string | null;
    syncError: string | null;
    rawPayloadPresent: boolean;
  };
}

export interface KaspiOrdersSummaryView {
  total: number;
  newOrNeedsAcceptance: number;
  accepted: number;
  handoffOrDeliveryInProgress: number;
  completed: number;
  cancelledOrReturned: number;
  unmatchedOrStockIssues: number;
}

export interface SaveKaspiConnectionInput {
  apiToken?: string;
  sellerName?: string;
  isActive?: boolean;
}

export interface ListKaspiOrdersInput {
  state?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface SendCompletionCodeResult {
  externalOrderId: string;
  externalOrderCode: string;
  status: string | null;
  state: string | null;
  codeSent: true;
}

export interface ConfirmCompletionCodeInput {
  securityCode: string;
}

export interface ConfirmCompletionCodeResult {
  externalOrderId: string;
  externalOrderCode: string;
  status: string | null;
  state: string | null;
  completed: boolean;
}

export interface SyncKaspiOrdersResult {
  fetched: number;
  upserted: number;
  fetchedPages: number;
  syncedAt: string;
}

export interface KaspiExportResult {
  buffer: Buffer;
  filename: string;
  contentType: string;
}
