import ExcelJS from 'exceljs';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  formatOrgCurrencyAmount,
  getOrgCurrencySymbol,
  normalizeOrgCurrency,
} from '../../lib/currency.js';
import { prisma } from '../../lib/prisma.js';

const MANUAL_INVOICE_PREFIX = '\u041c\u041d';

async function nextInvoiceNumber(orgId: string): Promise<string> {
  const last = await prisma.chapanManualInvoice.findFirst({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
    select: { invoiceNum: true },
  });

  if (!last) {
    return `${MANUAL_INVOICE_PREFIX}-0001`;
  }

  const match = last.invoiceNum.match(new RegExp(`^${MANUAL_INVOICE_PREFIX}-(\\d+)$`));
  const seq = match?.[1] ? Number.parseInt(match[1], 10) + 1 : 1;
  return `${MANUAL_INVOICE_PREFIX}-${String(seq).padStart(4, '0')}`;
}

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
  updatedAt: true,
  archivedAt: true,
  items: {
    select: {
      id: true,
      productName: true,
      gender: true,
      length: true,
      color: true,
      size: true,
      quantity: true,
      unitPrice: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

export interface ManualInvoiceItemDto {
  productName: string;
  gender?: string;
  length?: string;
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

export async function list(
  orgId: string,
  filters?: { type?: string; archived?: boolean },
) {
  return prisma.chapanManualInvoice.findMany({
    where: {
      orgId,
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.archived === true
        ? { archivedAt: { not: null } }
        : { archivedAt: null }),
    },
    select: invoiceSelect,
    orderBy: [
      { archivedAt: 'desc' },
      { createdAt: 'desc' },
    ],
  });
}

export async function getById(orgId: string, id: string) {
  const invoice = await prisma.chapanManualInvoice.findFirst({
    where: { orgId, id },
    select: invoiceSelect,
  });

  if (!invoice) {
    throw new NotFoundError('\u041d\u0430\u043a\u043b\u0430\u0434\u043d\u0430\u044f \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430');
  }

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
          gender: item.gender,
          length: item.length,
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
  const invoice = await getById(orgId, id);
  if (invoice.archivedAt) {
    throw new ValidationError('\u0410\u0440\u0445\u0438\u0432\u043d\u0443\u044e \u043d\u0430\u043a\u043b\u0430\u0434\u043d\u0443\u044e \u0441\u043d\u0430\u0447\u0430\u043b\u0430 \u043d\u0443\u0436\u043d\u043e \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c');
  }

  return prisma.$transaction(async (tx) => {
    if (dto.items !== undefined) {
      await tx.chapanManualInvoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.chapanManualInvoiceItem.createMany({
        data: dto.items.map((item) => ({
          invoiceId: id,
          productName: item.productName,
          gender: item.gender,
          length: item.length,
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

export async function archive(orgId: string, id: string) {
  const invoice = await getById(orgId, id);
  if (invoice.archivedAt) {
    throw new ValidationError('\u041d\u0430\u043a\u043b\u0430\u0434\u043d\u0430\u044f \u0443\u0436\u0435 \u0432 \u0430\u0440\u0445\u0438\u0432\u0435');
  }

  return prisma.chapanManualInvoice.update({
    where: { id },
    data: { archivedAt: new Date() },
    select: invoiceSelect,
  });
}

export async function restore(orgId: string, id: string) {
  const invoice = await getById(orgId, id);
  if (!invoice.archivedAt) {
    throw new ValidationError('\u041d\u0430\u043a\u043b\u0430\u0434\u043d\u0430\u044f \u0438 \u0442\u0430\u043a \u0432 \u0430\u043a\u0442\u0438\u0432\u043d\u043e\u043c \u0441\u043f\u0438\u0441\u043a\u0435');
  }

  return prisma.chapanManualInvoice.update({
    where: { id },
    data: { archivedAt: null },
    select: invoiceSelect,
  });
}

export async function generateXlsx(orgId: string, id: string) {
  const [invoice, org] = await Promise.all([
    getById(orgId, id),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { currency: true },
    }),
  ]);

  const currency = normalizeOrgCurrency(org?.currency);
  const currencySymbol = getOrgCurrencySymbol(currency);
  const typeLabel = invoice.type === 'workshop'
    ? '\u0426\u0435\u0445'
    : '\u0411\u0430\u0437\u0430\u0440';
  const totalAmount = invoice.items.reduce(
    (sum, item) => sum + item.unitPrice * item.quantity,
    0,
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KORT';
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet('\u0417\u0430\u043a\u0443\u043f');

  worksheet.columns = [
    { key: 'num', width: 6 },
    { key: 'productName', width: 32 },
    { key: 'gender', width: 14 },
    { key: 'length', width: 16 },
    { key: 'color', width: 16 },
    { key: 'size', width: 12 },
    { key: 'quantity', width: 10 },
    { key: 'unitPrice', width: 14 },
    { key: 'total', width: 16 },
  ];

  worksheet.mergeCells('A1:I1');
  worksheet.getCell('A1').value = invoice.title;
  worksheet.getCell('A1').font = { bold: true, size: 14 };
  worksheet.getCell('A1').alignment = { horizontal: 'center' };

  worksheet.mergeCells('A2:I2');
  worksheet.getCell('A2').value = [
    invoice.invoiceNum,
    typeLabel,
    new Date(invoice.createdAt).toLocaleDateString('ru-KZ'),
  ].join(' - ');
  worksheet.getCell('A2').alignment = { horizontal: 'center' };
  worksheet.getCell('A2').font = { color: { argb: 'FF888888' } };

  worksheet.addRow([]);

  const headerRow = worksheet.addRow([
    '\u2116',
    '\u041d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u0435',
    '\u041f\u043e\u043b',
    '\u0414\u043b\u0438\u043d\u0430',
    '\u0426\u0432\u0435\u0442',
    '\u0420\u0430\u0437\u043c\u0435\u0440',
    '\u041a\u043e\u043b-\u0432\u043e',
    '\u0426\u0435\u043d\u0430',
    '\u0418\u0442\u043e\u0433\u043e',
  ]);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF0F0F0' },
  };
  headerRow.eachCell((cell) => {
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
    cell.alignment = { horizontal: 'center' };
  });

  invoice.items.forEach((item, index) => {
    const row = worksheet.addRow([
      index + 1,
      item.productName,
      item.gender ?? '',
      item.length ?? '',
      item.color ?? '',
      item.size ?? '',
      item.quantity,
      item.unitPrice,
      item.unitPrice * item.quantity,
    ]);

    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      };
    });

    ['H', 'I'].forEach((column) => {
      worksheet.getCell(`${column}${row.number}`).numFmt = `#,##0 "${currencySymbol}"`;
    });

    ['A', 'C', 'D', 'F', 'G'].forEach((column) => {
      worksheet.getCell(`${column}${row.number}`).alignment = { horizontal: 'center' };
    });
  });

  worksheet.addRow([]);
  const totalRow = worksheet.addRow([
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '\u0418\u0422\u041e\u0413\u041e:',
    formatOrgCurrencyAmount(totalAmount, currency),
  ]);
  totalRow.font = { bold: true };

  if (invoice.notes) {
    worksheet.addRow([]);
    worksheet.addRow([
      '\u041f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438\u0435:',
      invoice.notes,
    ]);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const safeInvoiceNum = invoice.invoiceNum.replace(/[^\p{L}\p{N}]+/gu, '_');
  const filename = `zakup_${safeInvoiceNum}.xlsx`;

  return { buffer, filename };
}
