import ExcelJS from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

// ── Invoice number generation ─────────────────────────────────────────────────

async function nextInvoiceNumber(orgId: string): Promise<string> {
  const last = await prisma.chapanManualInvoice.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { invoiceNum: true },
  });

  if (!last) return 'МН-0001';
  const match = last.invoiceNum.match(/^МН-(\d+)$/);
  const seq = match?.[1] ? parseInt(match[1], 10) + 1 : 1;
  return `МН-${String(seq).padStart(4, '0')}`;
}

// ── Select shape ──────────────────────────────────────────────────────────────

const invoiceSelect = {
  id: true,
  orgId: true,
  type: true,
  invoiceNum: true,
  title: true,
  notes: true,
  createdById: true,
  createdByName: true,
  createdAt: true,
  items: {
    select: {
      id: true,
      productName: true,
      color: true,
      size: true,
      quantity: true,
      unitPrice: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface ManualInvoiceItemDto {
  productName: string;
  color?: string;
  size?: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateManualInvoiceDto {
  type: 'workshop' | 'market';
  title: string;
  notes?: string;
  items: ManualInvoiceItemDto[];
}

// ── Service functions ─────────────────────────────────────────────────────────

export async function list(orgId: string, type?: string) {
  return prisma.chapanManualInvoice.findMany({
    where: { orgId, ...(type ? { type } : {}) },
    select: invoiceSelect,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getById(orgId: string, id: string) {
  const invoice = await prisma.chapanManualInvoice.findFirst({
    where: { orgId, id },
    select: invoiceSelect,
  });
  if (!invoice) throw new NotFoundError('Накладная не найдена');
  return invoice;
}

export async function create(
  orgId: string,
  userId: string,
  userName: string,
  dto: CreateManualInvoiceDto,
) {
  const invoiceNum = await nextInvoiceNumber(orgId);

  return prisma.chapanManualInvoice.create({
    data: {
      orgId,
      invoiceNum,
      type: dto.type,
      title: dto.title,
      notes: dto.notes,
      createdById: userId,
      createdByName: userName,
      items: {
        create: dto.items.map((item) => ({
          productName: item.productName,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      },
    },
    select: invoiceSelect,
  });
}

export async function update(
  orgId: string,
  id: string,
  dto: Partial<Omit<CreateManualInvoiceDto, 'type'>>,
) {
  await getById(orgId, id);

  return prisma.$transaction(async (tx) => {
    if (dto.items !== undefined) {
      await tx.chapanManualInvoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.chapanManualInvoiceItem.createMany({
        data: dto.items.map((item) => ({
          invoiceId: id,
          productName: item.productName,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      });
    }

    return tx.chapanManualInvoice.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      select: invoiceSelect,
    });
  });
}

export async function remove(orgId: string, id: string) {
  await getById(orgId, id);
  await prisma.chapanManualInvoice.delete({ where: { id } });
  return { deleted: true };
}

export async function generateXlsx(orgId: string, id: string) {
  const invoice = await getById(orgId, id);

  const typeLabel = invoice.type === 'workshop' ? 'Цех' : 'Базар';
  const totalAmount = invoice.items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );
  const fmt = (n: number) =>
    new Intl.NumberFormat('ru-KZ', { maximumFractionDigits: 0 }).format(n);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KORT';
  workbook.created = new Date();

  const ws = workbook.addWorksheet('Закуп');

  ws.columns = [
    { key: 'num',         width: 6  },
    { key: 'productName', width: 32 },
    { key: 'color',       width: 14 },
    { key: 'size',        width: 12 },
    { key: 'quantity',    width: 10 },
    { key: 'unitPrice',   width: 14 },
    { key: 'total',       width: 16 },
  ];

  // Title block
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = invoice.title;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A1').alignment = { horizontal: 'center' };

  ws.mergeCells('A2:G2');
  ws.getCell('A2').value = `${invoice.invoiceNum} · ${typeLabel} · ${new Date(invoice.createdAt).toLocaleDateString('ru-KZ')}`;
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getCell('A2').font = { color: { argb: 'FF888888' } };

  ws.addRow([]);

  // Header row
  const headerRow = ws.addRow(['№', 'Наименование', 'Цвет', 'Размер', 'Кол-во', 'Цена', 'Итого']);
  headerRow.font = { bold: true };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' },
    };
    cell.alignment = { horizontal: 'center' };
  });

  // Data rows
  invoice.items.forEach((item, idx) => {
    const row = ws.addRow([
      idx + 1,
      item.productName,
      item.color ?? '',
      item.size ?? '',
      item.quantity,
      item.unitPrice,
      item.unitPrice * item.quantity,
    ]);
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' }, bottom: { style: 'thin' },
        left: { style: 'thin' }, right: { style: 'thin' },
      };
    });
    // Format currency cells
    ['F', 'G'].forEach((col) => {
      ws.getCell(`${col}${row.number}`).numFmt = '#,##0 "₸"';
    });
    ws.getCell(`E${row.number}`).alignment = { horizontal: 'center' };
    ws.getCell(`A${row.number}`).alignment = { horizontal: 'center' };
  });

  // Total row
  ws.addRow([]);
  const totalRow = ws.addRow(['', '', '', '', '', 'ИТОГО:', fmt(totalAmount) + ' ₸']);
  totalRow.font = { bold: true };

  if (invoice.notes) {
    ws.addRow([]);
    ws.addRow(['Примечание:', invoice.notes]);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const filename = `zakup_${invoice.invoiceNum.replace(/[^a-zA-Z0-9А-Яа-я]/g, '_')}.xlsx`;

  return { buffer, filename };
}
