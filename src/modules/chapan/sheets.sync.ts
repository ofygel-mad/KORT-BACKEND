/**
 * Sprint 10-11: Google Sheets sync module
 *
 * Architecture:
 * - Server-side only (never called from frontend)
 * - Idempotency: one order block per order number in column A
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
 *
 * Row schema is defined in sheets/row-builder.ts (independently testable).
 */

import { config } from '../../config.js';
import { prisma } from '../../lib/prisma.js';
import { calculateChapanOrderFinancials } from './financials.js';
import { buildSheetRows, SHEET_HEADER, type SheetCellValue } from './sheets/row-builder.js';

type SyncResult =
  | { ok: true; rowIndex: number }
  | { ok: false; error: string };

type SheetsClient = Awaited<ReturnType<typeof buildSheetsClient>>;
const TECH_ORDER_ID_COLUMN_INDEX = SHEET_HEADER.length - 1;

function getSheetsConfig() {
  return {
    spreadsheetId: config.GOOGLE_SHEETS_SPREADSHEET_ID,
    sheetName: config.GOOGLE_SHEETS_SHEET_NAME ?? 'Orders',
    serviceAccountEmail: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    privateKey: config.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  };
}

function columnLetter(columnNumber: number): string {
  let value = columnNumber;
  let result = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }

  return result;
}

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

export async function syncOrderToSheets(
  orgId: string,
  orderId: string,
): Promise<SyncResult> {
  if (!isSheetsConfigured()) {
    return { ok: false, error: 'Google Sheets not configured (see sheets.sync.ts)' };
  }

  try {
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

    const rowValues = buildSheetRows({
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      orderDate: (order as any).orderDate ?? null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      urgency: (order as any).urgency ?? null,
      isDemandingClient: (order as any).isDemandingClient ?? null,
      clientName: order.clientName,
      clientPhone: order.clientPhone,
      city: (order as any).city ?? null,
      streetAddress: (order as any).streetAddress ?? null,
      postalCode: (order as any).postalCode ?? null,
      deliveryType: (order as any).deliveryType ?? null,
      source: (order as any).source ?? null,
      dueDate: order.dueDate ?? null,
      expectedPaymentMethod: (order as any).expectedPaymentMethod ?? null,
      totalAmount: calculateChapanOrderFinancials({
        itemsSubtotal: order.totalAmount,
        orderDiscount: (order as any).orderDiscount ?? 0,
        deliveryFee: (order as any).deliveryFee ?? 0,
        bankCommissionPercent: (order as any).bankCommissionPercent ?? 0,
        bankCommissionAmount: (order as any).bankCommissionAmount ?? 0,
      }).totalDue,
      paidAmount: order.paidAmount,
      orderDiscount: (order as any).orderDiscount ?? 0,
      deliveryFee: (order as any).deliveryFee ?? 0,
      bankCommissionPercent: (order as any).bankCommissionPercent ?? 0,
      bankCommissionAmount: (order as any).bankCommissionAmount ?? 0,
      internalNote: (order as any).internalNote ?? null,
      shippingNote: (order as any).shippingNote ?? null,
      sourceRequestId: (order as any).sourceRequestId ?? null,
      paymentBreakdown: (order as any).paymentBreakdown ?? null,
      items: [...order.items]
        .sort((left, right) => {
          const leftPosition = Number((left as any).position ?? 0);
          const rightPosition = Number((right as any).position ?? 0);
          if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition;
          }
          return left.id.localeCompare(right.id);
        })
        .map(item => ({
          position: (item as any).position ?? null,
          productName: item.productName,
          color: item.color,
          gender: item.gender,
          length: item.length,
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          itemDiscount: (item as any).itemDiscount ?? 0,
          workshopNotes: item.workshopNotes,
        })),
      payments: order.payments.map(payment => ({
        method: payment.method,
        amount: (payment as any).amount ?? 0,
      })),
      attachments: order.attachments.map(attachment => ({
        originalName: attachment.fileName ?? null,
        filename: attachment.fileName ?? null,
      })),
    });

    return await withRetry(() => upsertRows(order.id, order.orderNumber, rowValues));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sheets.sync] Failed to sync order ${orderId}:`, message);
    return { ok: false, error: message };
  }
}

export async function ensureSheetHeader(): Promise<void> {
  if (!isSheetsConfigured()) return;
  try {
    await withRetry(() => ensureHeaderRow());
  } catch (err) {
    console.error('[sheets.sync] Failed to ensure header row:', err);
  }
}

function isSheetsConfigured(): boolean {
  const sheetsConfig = getSheetsConfig();
  const missing: string[] = [];
  if (!sheetsConfig.spreadsheetId) missing.push('GOOGLE_SHEETS_SPREADSHEET_ID');
  if (!sheetsConfig.serviceAccountEmail) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  if (!sheetsConfig.privateKey) missing.push('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');

  if (missing.length > 0 && missing.length < 3) {
    console.warn('[sheets.sync] Partially configured — missing:', missing.join(', '));
  }

  const sid = sheetsConfig.spreadsheetId ?? '';
  if (sid && sid.endsWith('.apps.googleusercontent.com')) {
    console.error(
      '[sheets.sync] GOOGLE_SHEETS_SPREADSHEET_ID looks like an OAuth Client ID, not a spreadsheet ID.\n' +
      '  Expected format: the alphanumeric ID from the Google Sheets URL, e.g.\n' +
      '  https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit',
    );
    return false;
  }

  return missing.length === 0;
}

async function buildSheetsClient() {
  const { google } = await import('googleapis');
  const sheetsConfig = getSheetsConfig();

  const rawKey = sheetsConfig.privateKey ?? '';
  const privateKey = rawKey.startsWith('-----')
    ? rawKey.replace(/\\n/g, '\n')
    : Buffer.from(rawKey, 'base64').toString('utf-8').replace(/\\n/g, '\n');

  const auth = new google.auth.JWT({
    email: sheetsConfig.serviceAccountEmail,
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
  sheets: SheetsClient,
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

async function getWorksheetId(
  sheets: SheetsClient,
  spreadsheetId: string,
  sheetName: string,
): Promise<number> {
  await ensureWorksheetExists(sheets, spreadsheetId, sheetName);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.sheetId,sheets.properties.title',
  });

  const sheetId = (meta.data.sheets ?? [])
    .map(sheet => sheet.properties)
    .find((properties) => properties?.title === sheetName)
    ?.sheetId;

  if (sheetId == null) {
    throw new Error(`Worksheet ${sheetName} not found`);
  }

  return sheetId;
}

async function deleteRows(
  sheets: SheetsClient,
  spreadsheetId: string,
  sheetId: number,
  rowIndexes: number[],
) {
  if (rowIndexes.length === 0) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: rowIndexes
        .sort((left, right) => right - left)
        .map((rowIndex) => ({
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        })),
    },
  });
}

async function upsertRows(
  orderId: string,
  orderNumber: string,
  values: SheetCellValue[][],
): Promise<SyncResult> {
  const sheets = await buildSheetsClient();
  const sheetsConfig = getSheetsConfig();
  const spreadsheetId = sheetsConfig.spreadsheetId!;
  const sheetName = sheetsConfig.sheetName;
  const sheetId = await getWorksheetId(sheets, spreadsheetId, sheetName);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: toSheetRange(sheetName, `A:${columnLetter(SHEET_HEADER.length)}`),
  });

  const rows = existing.data.values ?? [];
  const indexedRows = rows.map((row, index) => ({ row, rowIndex: index + 1 })).filter(({ rowIndex }) => rowIndex > 1);
  const idMatchedRows = indexedRows
    .filter(({ row }) => row[TECH_ORDER_ID_COLUMN_INDEX] === orderId)
    .map(({ rowIndex }) => rowIndex);
  const hasTechnicalIds = indexedRows.some(({ row }) => Boolean(row[TECH_ORDER_ID_COLUMN_INDEX]));
  const legacyMatchedRows = idMatchedRows.length === 0
    && !hasTechnicalIds
    ? indexedRows
      .filter(({ row }) => {
        const columnA = row[0];
        const columnB = row[1];
        return columnA === orderNumber || columnA === orderId || columnB === orderNumber;
      })
      .map(({ rowIndex }) => rowIndex)
    : [];
  const existingRowIndexes = idMatchedRows.length > 0 ? idMatchedRows : legacyMatchedRows;

  await deleteRows(sheets, spreadsheetId, sheetId, existingRowIndexes);

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: toSheetRange(sheetName, 'A1'),
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  const updatedRange = result.data.updates?.updatedRange ?? '';
  const match = updatedRange.match(/!A(\d+)/);
  const rowIndex = match?.[1] != null ? parseInt(match[1], 10) : -1;
  return { ok: true, rowIndex };
}

async function ensureHeaderRow(): Promise<void> {
  const sheets = await buildSheetsClient();
  const sheetsConfig = getSheetsConfig();
  const spreadsheetId = sheetsConfig.spreadsheetId!;
  const sheetName = sheetsConfig.sheetName;

  await ensureWorksheetExists(sheets, spreadsheetId, sheetName);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: toSheetRange(sheetName, `A1:${columnLetter(SHEET_HEADER.length)}1`),
  });

  const currentHeader = existing.data.values?.[0] ?? [];
  const isSameHeader = SHEET_HEADER.every((value, index) => (currentHeader[index] ?? '') === value);

  if (!isSameHeader) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: toSheetRange(sheetName, 'A1'),
      valueInputOption: 'RAW',
      requestBody: { values: [[...SHEET_HEADER]] },
    });
  }
}
