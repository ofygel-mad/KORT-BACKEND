import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { normalizeOrgCurrency } from '../../lib/currency.js';
import {
  buildInvoiceDocumentPayload,
  calculateInvoiceDocumentTotals,
  normalizeInvoiceDocumentPayload,
  type InvoiceDocumentColumnKey,
  type InvoiceDocumentPayload,
} from './invoice-document.js';
import { getNextInvoiceNumberCandidate } from './invoice-number.js';
import {
  generateDefaultBatchInvoiceTemplateXlsx,
  generateDefaultInvoiceTemplateXlsx,
} from './z2-invoice-template.service.js';

type InvoiceStyle = 'default' | 'branded';
type CellAlign = 'left' | 'center' | 'right';

interface OrderForInvoice {
  id: string;
  orderNumber: string;
  createdAt: Date;
  items: Array<{
    productName: string;
    size: string;
    quantity: number;
    unitPrice: number;
    color: string | null;
  }>;
}

interface TableColumn {
  key: InvoiceDocumentColumnKey;
  width: number;
  align: CellAlign;
}

const BRAND_GREEN = 'FF1A6B3C';
const BRAND_GREEN_SOFT = 'FFE6F4EC';
const BRAND_GREEN_ALT = 'FFF4FAF6';
const WHITE = 'FFFFFFFF';
const TEXT_DARK = 'FF101828';
const TEXT_MUTED = 'FF475467';
const BORDER_DARK = 'FF0F4A27';
const BORDER_SOFT = 'FFD0D5DD';
const BORDER_ACCENT = 'FF9FCFB4';

const TABLE_COLS: TableColumn[] = [
  { key: 'itemNumber', width: 11, align: 'center' },
  { key: 'productName', width: 28, align: 'left' },
  { key: 'gender', width: 11, align: 'center' },
  { key: 'length', width: 16, align: 'center' },
  { key: 'size', width: 11, align: 'center' },
  { key: 'color', width: 18, align: 'center' },
  { key: 'quantity', width: 10, align: 'center' },
  { key: 'orders', width: 22, align: 'center' },
  { key: 'unitPrice', width: 12, align: 'right' },
  { key: 'lineTotal', width: 14, align: 'right' },
];

const CURRENCY_SYMBOLS: Record<string, string> = {
  KZT: '₸', USD: '$', EUR: '€', CNY: '¥',
};

function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

function thinBorder(color: string) {
  const side = { style: 'thin' as const, color: { argb: color } };
  return { top: side, bottom: side, left: side, right: side };
}

function formatInvoiceDisplayNumber(invoiceNumber?: string) {
  return invoiceNumber ? `№-${invoiceNumber}` : '№-черновик';
}

function formatInvoiceDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('ru-RU');
}

function applyMetaPair(
  ws: import('exceljs').Worksheet,
  row: number,
  labelStartCol: number,
  labelEndCol: number,
  valueStartCol: number,
  valueEndCol: number,
  label: string,
  value: string | number,
  numFmtOverride?: string,
) {
  ws.mergeCells(row, labelStartCol, row, labelEndCol);
  ws.mergeCells(row, valueStartCol, row, valueEndCol);

  const labelCell = ws.getCell(row, labelStartCol);
  labelCell.value = label;
  labelCell.font = { bold: true, size: 11, color: { argb: TEXT_DARK }, name: 'Calibri' };
  labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_GREEN_SOFT } };
  labelCell.alignment = { horizontal: 'center', vertical: 'middle' };
  labelCell.border = thinBorder(BORDER_ACCENT);

  const valueCell = ws.getCell(row, valueStartCol);
  valueCell.value = value;
  valueCell.font = { size: 11, color: { argb: TEXT_DARK }, name: 'Calibri' };
  valueCell.alignment = { horizontal: 'center', vertical: 'middle' };
  valueCell.border = thinBorder(BORDER_ACCENT);
  if (typeof value === 'number') {
    valueCell.numFmt = numFmtOverride ?? '#,##0';
  }
}

async function createWorkbook(orgName: string) {
  const ExcelJS = await import('exceljs');
  const Workbook = ExcelJS.default?.Workbook ?? ExcelJS.Workbook;
  if (!Workbook) {
    throw new Error('ExcelJS Workbook class not found');
  }

  const wb = new Workbook();
  wb.creator = orgName;
  wb.created = new Date();

  const ws = wb.addWorksheet('Накладная', {
    pageSetup: {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
    },
  });

  TABLE_COLS.forEach((col, index) => {
    ws.getColumn(index + 1).width = col.width;
  });

  return { wb, ws };
}

async function generateBrandedInvoiceXlsx(
  orgName: string,
  document: InvoiceDocumentPayload,
  currency = 'KZT',
): Promise<Buffer> {
  const symbol = getCurrencySymbol(currency);
  const moneyFmt = `#,##0 "${symbol}"`;
  const { wb, ws } = await createWorkbook(orgName);
  const totals = calculateInvoiceDocumentTotals(document);

  ws.mergeCells(1, 1, 1, TABLE_COLS.length);
  const numberCell = ws.getCell(1, 1);
  numberCell.value = formatInvoiceDisplayNumber(document.invoiceNumber);
  numberCell.font = { bold: true, size: 18, color: { argb: BRAND_GREEN }, name: 'Calibri' };
  numberCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, TABLE_COLS.length);
  const titleCell = ws.getCell(2, 1);
  titleCell.value = 'Сводная накладная';
  titleCell.font = { bold: true, size: 12, color: { argb: TEXT_MUTED }, name: 'Calibri' };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 20;

  applyMetaPair(ws, 3, 1, 2, 3, 4, 'Дата', formatInvoiceDate(document.invoiceDate));
  applyMetaPair(ws, 3, 5, 6, 7, 8, 'Рейс', document.route);

  ws.mergeCells(3, 9, 3, 10);
  const signCell = ws.getCell(3, 9);
  signCell.value = document.signatureLabel || 'Подпись';
  signCell.font = { size: 12, color: { argb: TEXT_DARK }, name: 'Calibri' };
  signCell.alignment = { horizontal: 'center', vertical: 'middle' };
  signCell.border = thinBorder(BORDER_ACCENT);

  ws.getRow(3).height = 22;
  ws.getRow(4).height = 10;

  const headerRow = 5;
  ws.getRow(headerRow).height = 28;
  TABLE_COLS.forEach((col, index) => {
    const cell = ws.getCell(headerRow, index + 1);
    cell.value = document.columns[col.key];
    cell.font = { bold: true, size: 10, color: { argb: WHITE }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_GREEN } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = thinBorder(BORDER_DARK);
  });

  let rowIndex = headerRow + 1;
  for (const row of document.rows) {
    const rowBg = rowIndex % 2 === 0 ? BRAND_GREEN_ALT : WHITE;
    const lineTotal = Number(row.quantity) * Number(row.unitPrice);

    ws.getRow(rowIndex).height = 20;
    TABLE_COLS.forEach((col, columnIndex) => {
      const cell = ws.getCell(rowIndex, columnIndex + 1);
      const value = col.key === 'lineTotal' ? lineTotal : row[col.key];
      cell.value = value;
      cell.font = { size: 10, color: { argb: TEXT_DARK }, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      cell.alignment = { horizontal: col.align, vertical: 'middle', wrapText: true };
      cell.border = thinBorder(BORDER_SOFT);
      if (typeof value === 'number' && col.align === 'right') {
        cell.numFmt = moneyFmt;
      }
    });

    rowIndex += 1;
  }

  if (document.rows.length === 0) {
    ws.mergeCells(rowIndex, 1, rowIndex, TABLE_COLS.length);
    const emptyCell = ws.getCell(rowIndex, 1);
    emptyCell.value = 'В накладной нет позиций';
    emptyCell.font = { italic: true, size: 11, color: { argb: TEXT_MUTED }, name: 'Calibri' };
    emptyCell.alignment = { horizontal: 'center', vertical: 'middle' };
    emptyCell.border = thinBorder(BORDER_SOFT);
    ws.getRow(rowIndex).height = 24;
    rowIndex += 1;
  }

  const summaryStartRow = rowIndex + 1;
  ws.getRow(summaryStartRow - 1).height = 10;
  applyMetaPair(ws, summaryStartRow, 7, 8, 9, 10, 'Итого Кол.во', totals.totalQuantity);
  applyMetaPair(ws, summaryStartRow + 1, 7, 8, 9, 10, 'Итого Сумма', totals.totalAmount, moneyFmt);
  ws.getRow(summaryStartRow).height = 22;
  ws.getRow(summaryStartRow + 1).height = 22;

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function ordersToDocument(
  orders: OrderForInvoice[],
  invoiceMeta?: { invoiceNumber?: string; createdAt: Date },
) {
  return buildInvoiceDocumentPayload({
    invoiceNumber: invoiceMeta?.invoiceNumber,
    createdAt: invoiceMeta?.createdAt ?? orders[0]?.createdAt ?? new Date(),
    orders: orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      items: order.items,
    })),
  });
}

export async function generateInvoiceXlsx(
  orgId: string,
  orderId: string,
  style: InvoiceStyle,
): Promise<Buffer> {
  if (style === 'default') {
    return generateDefaultInvoiceTemplateXlsx(orgId, orderId);
  }

  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: {
      items: {
        select: {
          productName: true,
          size: true,
          quantity: true,
          unitPrice: true,
          color: true,
        },
      },
    },
  });

  if (!order) {
    throw new NotFoundError('ChapanOrder', orderId);
  }

  const linkedInvoice = await prisma.chapanInvoice.findFirst({
    where: {
      orgId,
      status: { in: ['pending_confirmation', 'confirmed'] },
      items: { some: { orderId } },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      invoiceNumber: true,
      createdAt: true,
      ...({ documentPayload: true } as Record<string, true>),
    },
  });

  const [profile, org] = await Promise.all([
    prisma.chapanProfile.findUnique({ where: { orgId } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } }),
  ]);
  const orgName = profile?.displayName ?? 'Чапан';
  const fallbackDocument = ordersToDocument([order as OrderForInvoice], linkedInvoice ?? undefined);
  const linkedInvoiceDocumentPayload = (linkedInvoice as { documentPayload?: unknown } | null)?.documentPayload;
  const document = linkedInvoiceDocumentPayload && typeof linkedInvoiceDocumentPayload === 'object'
    ? normalizeInvoiceDocumentPayload(linkedInvoiceDocumentPayload, fallbackDocument)
    : fallbackDocument;

  return generateBrandedInvoiceXlsx(orgName, document, normalizeOrgCurrency(org?.currency));
}

export async function generateBatchInvoiceXlsx(
  orgId: string,
  orderIds: string[],
  style: InvoiceStyle,
  invoiceMeta?: { invoiceNumber: string; createdAt: Date },
  documentPayload?: InvoiceDocumentPayload,
): Promise<Buffer> {
  if (style === 'default') {
    return generateDefaultBatchInvoiceTemplateXlsx(orgId, orderIds, invoiceMeta);
  }

  const orders = await prisma.chapanOrder.findMany({
    where: { id: { in: orderIds }, orgId },
    include: {
      items: {
        select: {
          productName: true,
          size: true,
          quantity: true,
          unitPrice: true,
          color: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) {
    throw new NotFoundError('ChapanOrder', orderIds.join(','));
  }

  const [profile, org] = await Promise.all([
    prisma.chapanProfile.findUnique({ where: { orgId } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { currency: true } }),
  ]);
  const orgName = profile?.displayName ?? 'Чапан';
  const resolvedInvoiceMeta = invoiceMeta ?? {
    invoiceNumber: await getNextInvoiceNumberCandidate(prisma, orgId, new Date()),
    createdAt: new Date(),
  };
  const fallbackDocument = ordersToDocument(orders as OrderForInvoice[], resolvedInvoiceMeta);
  const document = documentPayload
    ? normalizeInvoiceDocumentPayload(
      {
        ...documentPayload,
        invoiceNumber: documentPayload.invoiceNumber ?? resolvedInvoiceMeta.invoiceNumber,
      },
      fallbackDocument,
    )
    : fallbackDocument;

  return generateBrandedInvoiceXlsx(orgName, document, normalizeOrgCurrency(org?.currency));
}
