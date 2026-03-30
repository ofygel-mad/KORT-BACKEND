/**
 * Sprint 10-11: Google Sheets sync module
 *
 * Architecture:
 * - Server-side only (never called from frontend)
 * - Idempotency: one row per orderId, keyed by orderId in column A
 * - Retry with exponential backoff (3 attempts)
 * - Graceful degradation: sync errors are logged but never crash the order flow
 * - Triggered on: order create, status change, payment
 *
 * Setup:
 * 1. Create a Google Service Account in Google Cloud Console
 * 2. Share your target spreadsheet with the service account email
 * 3. Set env vars: GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL,
 *    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (base64-encoded or raw with \n)
 * 4. npm install googleapis
 * 5. Remove the `SHEETS_DISABLED` guard at the bottom of this file
 */

import { prisma } from '../../lib/prisma.js';

// ── Column schema ─────────────────────────────────────────────────────────────
// Each order maps to one row. Column order matches the header row in the sheet.
const HEADER_ROW = [
  'ID заказа',          // A — idempotency key
  'Номер заказа',       // B
  'Дата создания',      // C
  'Дата заказа',        // D (orderDate)
  'Статус',             // E
  'Статус оплаты',      // F
  'Срочность',          // G (urgency)
  'Требовательный',     // H (isDemandingClient)
  'Клиент',             // I
  'Телефон',            // J
  'Город',              // K
  'Тип доставки',       // L
  'Индекс',             // M (postalCode)
  'Срок готовности',    // N
  'Позиции',            // O (joined: product · color · size × qty)
  'Итого по позициям',  // P (before discount)
  'Доставка',           // Q (deliveryFee)
  'Скидка',             // R (orderDiscount)
  'Комиссия банка',     // S (bankCommissionAmount)
  'Итого к оплате',     // T (totalAmount)
  'Оплачено',           // U (paidAmount)
  'Остаток',            // V
  'Способ оплаты',      // W
  'Внутренняя заметка', // X (internalNote)
  'Последнее обновление', // Y
];

// ── Types ─────────────────────────────────────────────────────────────────────

type SyncResult =
  | { ok: true; rowIndex: number }
  | { ok: false; error: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(value: Date | null | undefined): string {
  if (!value) return '';
  return value.toLocaleDateString('ru-KZ', {
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function formatMoney(value: number): string {
  return value > 0 ? `${value.toLocaleString('ru-KZ')} ₸` : '';
}

function buildItemsSummary(items: Array<{
  productName: string;
  color?: string | null;
  gender?: string | null;
  size: string;
  quantity: number;
}>): string {
  return items
    .map(i => {
      const parts = [i.productName];
      if (i.color) parts.push(i.color);
      if (i.gender) parts.push(`(${i.gender})`);
      parts.push(i.size);
      const line = parts.join(' · ');
      return i.quantity > 1 ? `${line} × ${i.quantity}` : line;
    })
    .join('; ');
}

function buildRowValues(order: {
  id: string;
  orderNumber: string;
  createdAt: Date;
  orderDate?: Date | null;
  status: string;
  paymentStatus: string;
  urgency?: string;
  isDemandingClient?: boolean;
  priority?: string;
  clientName: string;
  clientPhone: string;
  city?: string | null;
  deliveryType?: string | null;
  postalCode?: string | null;
  dueDate?: Date | null;
  items: Array<{
    productName: string;
    color?: string | null;
    gender?: string | null;
    size: string;
    quantity: number;
    unitPrice: number;
  }>;
  deliveryFee?: number;
  orderDiscount?: number;
  bankCommissionAmount?: number;
  totalAmount: number;
  paidAmount: number;
  internalNote?: string | null;
  payments?: Array<{ method: string }>;
  updatedAt: Date;
}): string[] {
  const urgency = order.urgency ?? (order.priority === 'urgent' ? 'urgent' : 'normal');
  const isDemanding = order.isDemandingClient ?? (order.priority === 'vip');

  const itemsSubtotal = order.items.reduce(
    (sum, i) => sum + i.quantity * i.unitPrice, 0,
  );
  const paymentMethods = [...new Set(
    (order.payments ?? []).map(p => p.method),
  )].join(', ');

  return [
    order.id,                                                      // A
    order.orderNumber,                                             // B
    formatDate(order.createdAt),                                   // C
    formatDate(order.orderDate ?? null),                          // D
    order.status,                                                  // E
    order.paymentStatus,                                           // F
    urgency === 'urgent' ? 'Срочный' : 'Обычный',                // G
    isDemanding ? 'Да' : '',                                       // H
    order.clientName,                                              // I
    order.clientPhone,                                             // J
    order.city ?? '',                                              // K
    order.deliveryType ?? '',                                      // L
    order.postalCode ?? '',                                        // M
    formatDate(order.dueDate ?? null),                            // N
    buildItemsSummary(order.items),                                // O
    formatMoney(itemsSubtotal),                                    // P
    formatMoney(order.deliveryFee ?? 0),                          // Q
    formatMoney(order.orderDiscount ?? 0),                        // R
    formatMoney(order.bankCommissionAmount ?? 0),                 // S
    formatMoney(order.totalAmount),                                // T
    formatMoney(order.paidAmount),                                 // U
    formatMoney(order.totalAmount - order.paidAmount),            // V
    paymentMethods,                                                // W
    order.internalNote ?? '',                                      // X
    formatDate(order.updatedAt),                                   // Y
  ];
}

// ── Retry logic ───────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 800,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// ── Core sync function ────────────────────────────────────────────────────────

/**
 * Sync a single order to Google Sheets.
 *
 * Strategy:
 * 1. Load full order from DB (ensures we always push source-of-truth data)
 * 2. Find existing row by orderId in column A (idempotency)
 * 3. Update row if found, append if not
 *
 * This function is intentionally kept as a named export so it can be called
 * from any service layer without tight coupling.
 */
export async function syncOrderToSheets(
  orgId: string,
  orderId: string,
): Promise<SyncResult> {
  // Guard: disabled until googleapis is installed and credentials are set
  if (!isSheetsConfigured()) {
    return { ok: false, error: 'Google Sheets not configured (see sheets.sync.ts)' };
  }

  try {
    // 1. Load full order
    const order = await prisma.chapanOrder.findFirst({
      where: { id: orderId, orgId },
      include: {
        items: true,
        payments: true,
      },
    });

    if (!order) {
      return { ok: false, error: `Order ${orderId} not found` };
    }

    // 2. Build row values
    const rowValues = buildRowValues({
      ...order,
      items: order.items.map(i => ({
        productName: i.productName,
        color: i.color,
        gender: i.gender,
        size: i.size,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
      })),
      payments: order.payments,
      orderDate: (order as any).orderDate ?? null,
      postalCode: (order as any).postalCode ?? null,
      deliveryFee: (order as any).deliveryFee ?? 0,
      orderDiscount: (order as any).orderDiscount ?? 0,
      bankCommissionAmount: (order as any).bankCommissionAmount ?? 0,
    });

    // 3. Upsert to sheet
    return await withRetry(() => upsertRow(orderId, rowValues));

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sheets.sync] Failed to sync order ${orderId}:`, message);
    return { ok: false, error: message };
  }
}

/**
 * Ensure the header row exists in the sheet.
 * Safe to call multiple times — checks first.
 */
export async function ensureSheetHeader(): Promise<void> {
  if (!isSheetsConfigured()) return;
  try {
    await withRetry(() => ensureHeaderRow());
  } catch (err) {
    console.error('[sheets.sync] Failed to ensure header row:', err);
  }
}

// ── Google Sheets API integration ─────────────────────────────────────────────
// This section is the only part that touches the googleapis SDK.
// Everything above is pure TypeScript — no external dependencies.

function isSheetsConfigured(): boolean {
  return !!(
    process.env.GOOGLE_SHEETS_SPREADSHEET_ID &&
    process.env.GOOGLE_SHEETS_API_KEY
  );
}

/**
 * Upsert a row in the sheet.
 * Searches column A for the orderId (idempotency key).
 * Updates the row if found, appends a new row if not.
 *
 * NOTE: Uncomment and install `googleapis` to activate.
 */
async function upsertRow(
  orderId: string,
  values: string[],
): Promise<SyncResult> {
  // ── Using Google Sheets API with API Key ──────────────────────────────────
  const { google } = await import('googleapis');

  const sheets = google.sheets({
    version: 'v4',
    auth: process.env.GOOGLE_SHEETS_API_KEY,
  });

  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders';

  // Find existing row
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:A`,
  });

  const rows = existing.data.values ?? [];
  const existingRowIndex = rows.findIndex(row => row[0] === orderId);

  if (existingRowIndex >= 1) {
    // Update existing row (1-indexed, skip header at row 1)
    const rowNumber = existingRowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A${rowNumber}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    return { ok: true, rowIndex: rowNumber };
  } else {
    // Append new row
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
    const updatedRange = result.data.updates?.updatedRange ?? '';
    const match = updatedRange.match(/!A(\d+)/);
    const rowIndex = match ? parseInt(match[1], 10) : -1;
    return { ok: true, rowIndex };
  }
  // ─────────────────────────────────────────────────────────────────────────
}

async function ensureHeaderRow(): Promise<void> {
  // ── Using Google Sheets API with API Key ──────────────────────────────────
  const { google } = await import('googleapis');
  const sheets = google.sheets({
    version: 'v4',
    auth: process.env.GOOGLE_SHEETS_API_KEY,
  });
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders';

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:A1`,
  });

  if (!existing.data.values?.[0]?.[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER_ROW] },
    });
  }
  // ─────────────────────────────────────────────────────────────────────────
}
