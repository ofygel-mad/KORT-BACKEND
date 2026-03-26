import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

// ── Palette ──────────────────────────────────────────────────────────────────

const BRAND_GREEN      = 'FF1A6B3C';   // dark green header bg
const BRAND_GREEN_SOFT = 'FFE6F4EC';   // light green totals row
const BRAND_GREEN_ALT  = 'FFF4FAF6';   // zebra stripe even rows
const WHITE            = 'FFFFFFFF';
const TEXT_DARK        = 'FF101828';

const BORDER_THIN: ExcelJS.BorderStyle = 'thin';

function allBorders(color = 'FFD0D5DD'): Partial<ExcelJS.Borders> {
  const s = { style: BORDER_THIN, color: { argb: color } } as ExcelJS.Border;
  return { top: s, bottom: s, left: s, right: s };
}

// ── Column definitions ───────────────────────────────────────────────────────

const COLS = [
  { label: '№ Накладной',   key: 'invoiceNum',   width: 18, align: 'center' },
  { label: 'Дата',          key: 'date',          width: 13, align: 'center' },
  { label: '№ товара',      key: 'itemNum',        width: 10, align: 'center' },
  { label: 'Товар',         key: 'productName',   width: 30, align: 'left'   },
  { label: 'Муж/Жен',       key: 'gender',        width: 10, align: 'center' },
  { label: 'Длина изделия', key: 'length',         width: 15, align: 'center' },
  { label: 'Размер',        key: 'size',           width: 10, align: 'center' },
  { label: 'Цвет',          key: 'color',          width: 16, align: 'center' },
  { label: 'Кол-во',        key: 'quantity',       width: 9,  align: 'center' },
  { label: 'Заказы',        key: 'orderRef',       width: 14, align: 'center' },
  { label: 'Цена',          key: 'price',          width: 12, align: 'right'  },
  { label: 'Сумма',         key: 'amount',         width: 13, align: 'right'  },
  { label: 'Итого Сумма',   key: 'total',          width: 15, align: 'right'  },
] as const;

type ColKey = (typeof COLS)[number]['key'];

// ── Helper: try to detect gender from product name ───────────────────────────

function detectGender(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('муж') || n.includes('мужской') || n.includes('мужск')) return 'муж';
  if (n.includes('жен') || n.includes('женский') || n.includes('женск')) return 'жен';
  return '';
}

// ── Helper: apply cell value + style ─────────────────────────────────────────

function styleCell(
  cell: ExcelJS.Cell,
  value: ExcelJS.CellValue,
  opts: {
    bold?: boolean;
    fontSize?: number;
    textColor?: string;
    bgColor?: string;
    align?: 'left' | 'center' | 'right';
    borders?: boolean;
    borderColor?: string;
    numFmt?: string;
  } = {},
) {
  cell.value = value;
  cell.font = {
    bold: opts.bold ?? false,
    size: opts.fontSize ?? 10,
    color: { argb: opts.textColor ?? TEXT_DARK },
    name: 'Calibri',
  };
  if (opts.bgColor) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bgColor } };
  }
  cell.alignment = {
    horizontal: opts.align ?? 'left',
    vertical: 'middle',
    wrapText: false,
  };
  if (opts.borders !== false) {
    cell.border = allBorders(opts.borderColor);
  }
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

// ── Main generator ────────────────────────────────────────────────────────────

export async function generateInvoiceXlsx(
  orgId: string,
  orderId: string,
  style: 'default' | 'branded',
): Promise<Buffer> {
  console.log('[invoice] querying order:', { orderId, orgId });
  const order = await prisma.chapanOrder.findFirst({
    where: { id: orderId, orgId },
    include: { items: true },
  });
  console.log('[invoice] found order:', order ? { id: order.id, status: order.status, orgId: order.orgId } : null);
  if (!order) throw new NotFoundError('ChapanOrder', orderId);

  const profile = await prisma.chapanProfile.findUnique({ where: { orgId } });
  const orgName = profile?.displayName ?? 'Чапан';

  const wb = new ExcelJS.Workbook();
  wb.creator = orgName;
  wb.created = new Date();

  const ws = wb.addWorksheet('Накладная', {
    pageSetup: {
      paperSize: 9,           // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    },
  });

  // Set column widths
  COLS.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
  });

  // ── Branded header section ────────────────────────────────────────────────
  let headerRow = 1; // row index where the table header starts

  if (style === 'branded') {
    // Row 1 — company name
    ws.mergeCells(1, 1, 1, COLS.length);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = orgName.toUpperCase();
    titleCell.font = { bold: true, size: 16, color: { argb: BRAND_GREEN }, name: 'Calibri' };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 32;

    // Row 2 — document meta
    ws.mergeCells(2, 1, 2, COLS.length);
    const metaCell = ws.getCell(2, 1);
    const dateStr = order.dueDate
      ? new Date(order.dueDate).toLocaleDateString('ru-RU')
      : new Date(order.createdAt).toLocaleDateString('ru-RU');
    metaCell.value = `Накладная: ${order.orderNumber}   ·   Клиент: ${order.clientName}   ·   Телефон: ${order.clientPhone}   ·   Дата: ${dateStr}`;
    metaCell.font = { size: 10, color: { argb: 'FF555F7B' }, name: 'Calibri' };
    metaCell.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(2).height = 18;

    // Row 3 — blank spacer
    ws.getRow(3).height = 6;

    headerRow = 4;
  }

  // ── Table header row ──────────────────────────────────────────────────────
  const hRow = ws.getRow(headerRow);
  hRow.height = 24;

  COLS.forEach((col, i) => {
    const cell = ws.getCell(headerRow, i + 1);
    styleCell(cell, col.label, {
      bold: true,
      fontSize: 10,
      textColor: style === 'branded' ? WHITE : TEXT_DARK,
      bgColor: style === 'branded' ? BRAND_GREEN : 'FFD1FAE5',
      align: 'center',
      borderColor: style === 'branded' ? 'FF0F4A27' : 'FF6EE7B7',
    });
  });

  // ── Data rows ─────────────────────────────────────────────────────────────
  const dateISO = order.dueDate
    ? new Date(order.dueDate).toISOString().slice(0, 10)
    : new Date(order.createdAt).toISOString().slice(0, 10);

  let grandTotal = 0;

  order.items.forEach((item, idx) => {
    const rowIdx = headerRow + 1 + idx;
    const isEven = idx % 2 === 1;
    const rowBg = style === 'branded' && isEven ? BRAND_GREEN_ALT : WHITE;
    const lineTotal = item.quantity * item.unitPrice;
    grandTotal += lineTotal;

    const rowData: Record<ColKey, ExcelJS.CellValue> = {
      invoiceNum:   idx === 0 ? order.orderNumber : '',
      date:         idx === 0 ? dateISO : '',
      itemNum:      idx + 1,
      productName:  item.productName,
      gender:       detectGender(item.productName),
      length:       'Стандарт',
      size:         item.size,
      color:        '',       // color not in DB yet
      quantity:     item.quantity,
      orderRef:     `${idx + 1}-${order.orderNumber}`,
      price:        item.unitPrice > 0 ? item.unitPrice : 0,
      amount:       lineTotal > 0 ? lineTotal : 0,
      total:        '',
    };

    const row = ws.getRow(rowIdx);
    row.height = 18;

    COLS.forEach((col, i) => {
      const cell = ws.getCell(rowIdx, i + 1);
      const isNum = ['price', 'amount', 'total'].includes(col.key);
      styleCell(cell, rowData[col.key], {
        bgColor: rowBg,
        align: col.align as 'left' | 'center' | 'right',
        numFmt: isNum ? '#,##0' : undefined,
        borderColor: 'FFD0D5DD',
      });
    });
  });

  // ── Totals row ────────────────────────────────────────────────────────────
  const totalRowIdx = headerRow + 1 + order.items.length;
  const totalRow = ws.getRow(totalRowIdx);
  totalRow.height = 22;

  COLS.forEach((col, i) => {
    const cell = ws.getCell(totalRowIdx, i + 1);
    let value: ExcelJS.CellValue = '';

    if (col.key === 'productName') value = 'ИТОГО';
    else if (col.key === 'amount')  value = grandTotal;
    else if (col.key === 'total')   value = grandTotal;

    styleCell(cell, value, {
      bold: true,
      bgColor: BRAND_GREEN_SOFT,
      align: col.key === 'productName' ? 'left' : col.align as 'left' | 'center' | 'right',
      numFmt: ['amount', 'total'].includes(col.key) ? '#,##0' : undefined,
      borderColor: 'FF9FCFB4',
    });
  });

  // ── Freeze header row ─────────────────────────────────────────────────────
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];

  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}
