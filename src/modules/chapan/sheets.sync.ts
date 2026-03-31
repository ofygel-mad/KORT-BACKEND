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
 *
 * Row schema is defined in sheets/row-builder.ts (independently testable).
 */

import { prisma } from '../../lib/prisma.js';
import { buildSheetRow, SHEET_HEADER } from './sheets/row-builder.js';

// ── Types ─────────────────────────────────────────────────────────────────────

type SyncResult =
  | { ok: true; rowIndex: number }
  | { ok: false; error: string };

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
 */
export async function syncOrderToSheets(
  orgId: string,
  orderId: string,
): Promise<SyncResult> {
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
        attachments: {
          select: {
            id: true,
            fileName: true,
          },
        },
      },
    });

    if (!order) {
      return { ok: false, error: `Order ${orderId} not found` };
    }

    // 2. Build row values using the versioned row-builder
    const rowValues = buildSheetRow({
      id:            order.id,
      orderNumber:   order.orderNumber,
      createdAt:     order.createdAt,
      updatedAt:     order.updatedAt,
      orderDate:     (order as any).orderDate     ?? null,
      status:        order.status,
      paymentStatus: order.paymentStatus,
      urgency:               (order as any).urgency               ?? null,
      isDemandingClient:     (order as any).isDemandingClient     ?? null,
      clientName:    order.clientName,
      clientPhone:   order.clientPhone,
      city:                  (order as any).city                  ?? null,
      streetAddress:         (order as any).streetAddress         ?? null,
      postalCode:            (order as any).postalCode            ?? null,
      deliveryType:          (order as any).deliveryType          ?? null,
      source:                (order as any).source                ?? null,
      dueDate:       order.dueDate ?? null,
      expectedPaymentMethod: (order as any).expectedPaymentMethod ?? null,
      totalAmount:   order.totalAmount,
      paidAmount:    order.paidAmount,
      orderDiscount:         (order as any).orderDiscount         ?? 0,
      deliveryFee:           (order as any).deliveryFee           ?? 0,
      bankCommissionPercent: (order as any).bankCommissionPercent ?? 0,
      bankCommissionAmount:  (order as any).bankCommissionAmount  ?? 0,
      internalNote:          (order as any).internalNote          ?? null,
      shippingNote:          (order as any).shippingNote          ?? null,
      sourceRequestId:       (order as any).sourceRequestId       ?? null,
      items: order.items.map(item => ({
        productName:   item.productName,
        fabric:        item.fabric,
        color:         item.color,
        gender:        item.gender,
        length:        item.length,
        size:          item.size,
        quantity:      item.quantity,
        unitPrice:     item.unitPrice,
        itemDiscount:  (item as any).itemDiscount ?? 0,
        workshopNotes: item.workshopNotes,
      })),
      payments: order.payments.map(p => ({
        method: p.method,
        amount: (p as any).amount ?? 0,
      })),
      attachments: order.attachments.map(a => ({
        originalName: a.fileName ?? null,
        filename:     a.fileName ?? null,
      })),
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

function isSheetsConfigured(): boolean {
  const missing: string[] = [];
  if (!process.env.GOOGLE_SHEETS_SPREADSHEET_ID) missing.push('GOOGLE_SHEETS_SPREADSHEET_ID');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)  missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');

  // Warn once per process start if partially configured
  if (missing.length > 0 && missing.length < 3) {
    console.warn('[sheets.sync] Partially configured — missing:', missing.join(', '));
  }
  // Detect common mistake: SPREADSHEET_ID looks like an OAuth Client ID
  const sid = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '';
  if (sid && sid.endsWith('.apps.googleusercontent.com')) {
    console.error(
      '[sheets.sync] GOOGLE_SHEETS_SPREADSHEET_ID looks like an OAuth Client ID, not a spreadsheet ID.\n' +
      '  Expected format: the alphanumeric ID from the Google Sheets URL, e.g.\n' +
      '  https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit'
    );
    return false;
  }

  return missing.length === 0;
}

/**
 * Build an authenticated Google Sheets client using a Service Account.
 * The private key can be stored as base64 (recommended for env vars) or
 * raw with literal \n characters (they are normalised here).
 */
async function buildSheetsClient() {
  const { google } = await import('googleapis');

  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ?? '';
  const privateKey = rawKey.startsWith('-----')
    ? rawKey.replace(/\\n/g, '\n')
    : Buffer.from(rawKey, 'base64').toString('utf-8').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

function toSheetRange(sheetName: string, range: string): string {
  const escapedSheetName = sheetName.replace(/'/g, "''");
  return `'${escapedSheetName}'!${range}`;
}

async function ensureWorksheetExists(
  sheets: Awaited<ReturnType<typeof buildSheetsClient>>,
  spreadsheetId: string,
  sheetName: string,
) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  });

  const existingTitles = new Set(
    (meta.data.sheets ?? [])
      .map(sheet => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)),
  );

  if (existingTitles.has(sheetName)) {
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: sheetName,
            },
          },
        },
      ],
    },
  });
}

/**
 * Upsert a row in the sheet.
 * Searches column A for the orderId (idempotency key).
 * Updates the row if found, appends a new row if not.
 */
async function upsertRow(
  orderId: string,
  values: string[],
): Promise<SyncResult> {
  const sheets = await buildSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders';
  const columnARange = toSheetRange(sheetName, 'A:A');
  const appendRange = toSheetRange(sheetName, 'A1');

  await ensureWorksheetExists(sheets, spreadsheetId, sheetName);

  // Find existing row
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: columnARange,
  });

  const rows = existing.data.values ?? [];
  const existingRowIndex = rows.findIndex(row => row[0] === orderId);

  if (existingRowIndex >= 1) {
    // Update existing row (1-indexed, skip header at row 1)
    const rowNumber = existingRowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: toSheetRange(sheetName, `A${rowNumber}`),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [values] },
    });
    return { ok: true, rowIndex: rowNumber };
  } else {
    // Append new row
    const result = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: appendRange,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
    const updatedRange = result.data.updates?.updatedRange ?? '';
    const match = updatedRange.match(/!A(\d+)/);
    const rowIndex = match?.[1] != null ? parseInt(match[1], 10) : -1;
    return { ok: true, rowIndex };
  }
}

async function ensureHeaderRow(): Promise<void> {
  const sheets = await buildSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
  const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders';
  const headerRange = toSheetRange(sheetName, 'A1:A1');

  await ensureWorksheetExists(sheets, spreadsheetId, sheetName);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: headerRange,
  });

  if (!existing.data.values?.[0]?.[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: toSheetRange(sheetName, 'A1'),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[...SHEET_HEADER]] },
    });
  }
}
