import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

// ── Types ────────────────────────────────────────────────────────────────────

type InvoiceStyle = 'default' | 'branded';

interface OrderForInvoice {
  id: string;
  orderNumber: string;
  clientName: string;
  clientPhone: string;
  dueDate: Date | null;
  createdAt: Date;
  items: Array<{
    productName: string;
    size: string;
    quantity: number;
    unitPrice: number;
    color: string | null;
  }>;
}

// ── Palette ──────────────────────────────────────────────────────────────────

const BRAND_GREEN      = 'FF1A6B3C';
const BRAND_GREEN_SOFT = 'FFE6F4EC';
const BRAND_GREEN_ALT  = 'FFF4FAF6';
const WHITE            = 'FFFFFFFF';
const TEXT_DARK        = 'FF101828';

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectGender(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('муж') || n.includes('мужской') || n.includes('мужск')) return 'муж';
  if (n.includes('жен') || n.includes('женский') || n.includes('женск')) return 'жен';
  return '';
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('ru-RU');
}

function fmtDateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Column schema ────────────────────────────────────────────────────────────

const COLS = [
  { label: '№ Накладной',   width: 18, align: 'center' as const },
  { label: 'Дата',          width: 13, align: 'center' as const },
  { label: '№ товара',      width: 10, align: 'center' as const },
  { label: 'Товар',         width: 30, align: 'left'   as const },
  { label: 'Муж/Жен',       width: 10, align: 'center' as const },
  { label: 'Длина изделия', width: 15, align: 'center' as const },
  { label: 'Размер',        width: 10, align: 'center' as const },
  { label: 'Цвет',          width: 16, align: 'center' as const },
  { label: 'Кол-во',        width: 9,  align: 'center' as const },
  { label: 'Заказы',        width: 14, align: 'center' as const },
  { label: 'Цена',          width: 12, align: 'right'  as const },
  { label: 'Сумма',         width: 13, align: 'right'  as const },
  { label: 'Итого Сумма',   width: 15, align: 'right'  as const },
];

// ── Build row data for an item ───────────────────────────────────────────────

function buildRow(
  order: OrderForInvoice,
  item: OrderForInvoice['items'][number],
  idx: number,
  dateISO: string,
): (string | number)[] {
  const lineTotal = item.quantity * item.unitPrice;
  return [
    idx === 0 ? order.orderNumber : '',
    idx === 0 ? dateISO : '',
    idx + 1,
    item.productName,
    detectGender(item.productName),
    'Стандарт',
    item.size,
    item.color ?? '',
    item.quantity,
    `${idx + 1}-${order.orderNumber}`,
    item.unitPrice > 0 ? item.unitPrice : 0,
    lineTotal > 0 ? lineTotal : 0,
    '',
  ];
}

// ── Main: generate xlsx buffer ───────────────────────────────────────────────

export async function generateInvoiceXlsx(
  orgId: string,
  orderId: string,
  style: InvoiceStyle,
): Promise<Buffer> {
  // 1. Fetch data
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

  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  const orgName = profile?.displayName ?? 'Чапан';

  // 2. Lazy-import ExcelJS (avoids breaking module load if exceljs has issues)
  const ExcelJS = await import('exceljs');
  const Workbook = ExcelJS.default?.Workbook ?? ExcelJS.Workbook;

  if (!Workbook) {
    throw new Error('ExcelJS Workbook class not found — check exceljs installation');
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
      margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    },
  });

  // Column widths
  COLS.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  const isBranded = style === 'branded';
  let headerRow = 1;

  // 3. Branded header
  if (isBranded) {
    ws.mergeCells(1, 1, 1, COLS.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = orgName.toUpperCase();
    titleCell.font = { bold: true, size: 16, color: { argb: BRAND_GREEN }, name: 'Calibri' };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;

    ws.mergeCells(2, 1, 2, COLS.length);
    const metaCell = ws.getCell(2, 1);
    const dateStr = fmtDate(order.dueDate ?? order.createdAt);
    metaCell.value = `Накладная: ${order.orderNumber}   ·   Клиент: ${order.clientName}   ·   Телефон: ${order.clientPhone}   ·   Дата: ${dateStr}`;
    metaCell.font = { size: 10, color: { argb: 'FF555F7B' }, name: 'Calibri' };
    metaCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;
    ws.getRow(3).height = 6;
    headerRow = 4;
  }

  // 4. Table header
  const thinBorder = (color: string) => {
    const s = { style: 'thin' as const, color: { argb: color } };
    return { top: s, bottom: s, left: s, right: s };
  };

  ws.getRow(headerRow).height = 24;
  COLS.forEach((col, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = col.label;
    cell.font = { bold: true, size: 10, color: { argb: isBranded ? WHITE : TEXT_DARK }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isBranded ? BRAND_GREEN : 'FFD1FAE5' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    cell.border = thinBorder(isBranded ? 'FF0F4A27' : 'FF6EE7B7');
  });

  // 5. Data rows
  const dateISO = fmtDateISO(order.dueDate ?? order.createdAt);
  let grandTotal = 0;

  order.items.forEach((item, idx) => {
    const lineTotal = item.quantity * item.unitPrice;
    grandTotal += lineTotal;

    const values = buildRow(order, item, idx, dateISO);
    const rowIdx = headerRow + 1 + idx;
    const isEven = idx % 2 === 1;
    const rowBg = isBranded && isEven ? BRAND_GREEN_ALT : WHITE;

    ws.getRow(rowIdx).height = 18;
    values.forEach((val, i) => {
      const cell = ws.getCell(rowIdx, i + 1);
      cell.value = val;
      cell.font = { size: 10, color: { argb: TEXT_DARK }, name: 'Calibri' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
      cell.alignment = { horizontal: COLS[i]!.align, vertical: 'middle', wrapText: false };
      cell.border = thinBorder('FFD0D5DD');
      if (['right'].includes(COLS[i]!.align) && typeof val === 'number') {
        cell.numFmt = '#,##0';
      }
    });
  });

  // 6. Totals row
  const totalRowIdx = headerRow + 1 + order.items.length;
  ws.getRow(totalRowIdx).height = 22;
  COLS.forEach((col, i) => {
    const cell = ws.getCell(totalRowIdx, i + 1);
    let value: string | number = '';
    if (col.label === 'Товар') value = 'ИТОГО';
    else if (col.label === 'Сумма' || col.label === 'Итого Сумма') value = grandTotal;

    cell.value = value;
    cell.font = { bold: true, size: 10, color: { argb: TEXT_DARK }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_GREEN_SOFT } };
    cell.alignment = { horizontal: col.align, vertical: 'middle', wrapText: false };
    cell.border = thinBorder('FF9FCFB4');
    if (typeof value === 'number') cell.numFmt = '#,##0';
  });

  // 7. Freeze pane
  ws.views = [{ state: 'frozen' as const, ySplit: headerRow, xSplit: 0 }];

  // 8. Write buffer
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ── Batch invoice: combine multiple orders into one XLSX ────────────────────

export async function generateBatchInvoiceXlsx(
  orgId: string,
  orderIds: string[],
  style: InvoiceStyle,
): Promise<Buffer> {
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

  if (orders.length === 0) throw new NotFoundError('ChapanOrder', orderIds.join(','));

  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  const orgName = profile?.displayName ?? 'Чапан';

  const ExcelJS = await import('exceljs');
  const Workbook = ExcelJS.default?.Workbook ?? ExcelJS.Workbook;
  if (!Workbook) throw new Error('ExcelJS Workbook class not found');

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
      margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    },
  });

  COLS.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  const isBranded = style === 'branded';
  let headerRow = 1;

  if (isBranded) {
    ws.mergeCells(1, 1, 1, COLS.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = orgName.toUpperCase();
    titleCell.font = { bold: true, size: 16, color: { argb: BRAND_GREEN }, name: 'Calibri' };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;

    ws.mergeCells(2, 1, 2, COLS.length);
    const metaCell = ws.getCell(2, 1);
    metaCell.value = `Сводная накладная   ·   Заказов: ${orders.length}   ·   Дата: ${fmtDate(new Date())}`;
    metaCell.font = { size: 10, color: { argb: 'FF555F7B' }, name: 'Calibri' };
    metaCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;
    ws.getRow(3).height = 6;
    headerRow = 4;
  }

  const thinBorder = (color: string) => {
    const s = { style: 'thin' as const, color: { argb: color } };
    return { top: s, bottom: s, left: s, right: s };
  };

  ws.getRow(headerRow).height = 24;
  COLS.forEach((col, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = col.label;
    cell.font = { bold: true, size: 10, color: { argb: isBranded ? WHITE : TEXT_DARK }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isBranded ? BRAND_GREEN : 'FFD1FAE5' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: false };
    cell.border = thinBorder(isBranded ? 'FF0F4A27' : 'FF6EE7B7');
  });

  let globalIdx = 0;
  let grandTotal = 0;

  for (const order of orders) {
    const dateISO = fmtDateISO(order.dueDate ?? order.createdAt);

    for (let itemIdx = 0; itemIdx < order.items.length; itemIdx++) {
      const item = order.items[itemIdx]!;
      const lineTotal = item.quantity * item.unitPrice;
      grandTotal += lineTotal;

      const values = buildRow(order as unknown as OrderForInvoice, item, itemIdx, dateISO);
      const rowIdx = headerRow + 1 + globalIdx;
      const isEven = globalIdx % 2 === 1;
      const rowBg = isBranded && isEven ? BRAND_GREEN_ALT : WHITE;

      ws.getRow(rowIdx).height = 18;
      values.forEach((val, i) => {
        const cell = ws.getCell(rowIdx, i + 1);
        cell.value = val;
        cell.font = { size: 10, color: { argb: TEXT_DARK }, name: 'Calibri' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
        cell.alignment = { horizontal: COLS[i]!.align, vertical: 'middle', wrapText: false };
        cell.border = thinBorder('FFD0D5DD');
        if (['right'].includes(COLS[i]!.align) && typeof val === 'number') {
          cell.numFmt = '#,##0';
        }
      });

      globalIdx++;
    }
  }

  const totalRowIdx = headerRow + 1 + globalIdx;
  ws.getRow(totalRowIdx).height = 22;
  COLS.forEach((col, i) => {
    const cell = ws.getCell(totalRowIdx, i + 1);
    let value: string | number = '';
    if (col.label === 'Товар') value = 'ИТОГО';
    else if (col.label === 'Сумма' || col.label === 'Итого Сумма') value = grandTotal;

    cell.value = value;
    cell.font = { bold: true, size: 10, color: { argb: TEXT_DARK }, name: 'Calibri' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_GREEN_SOFT } };
    cell.alignment = { horizontal: col.align, vertical: 'middle', wrapText: false };
    cell.border = thinBorder('FF9FCFB4');
    if (typeof value === 'number') cell.numFmt = '#,##0';
  });

  ws.views = [{ state: 'frozen' as const, ySplit: headerRow, xSplit: 0 }];

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
