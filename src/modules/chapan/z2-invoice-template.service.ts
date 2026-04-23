import { fileURLToPath } from 'node:url';
import type { Worksheet } from 'exceljs';
import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

type TemplateOrder = {
  id: string;
  orderNumber: string;
  clientName: string;
  clientPhone: string;
  clientPhoneForeign: string | null;
  createdAt: Date;
  items: Array<{
    productName: string;
    size: string;
    quantity: number;
    unitPrice: number;
    color: string | null;
  }>;
};

type TemplateOrg = {
  name: string;
  legalName: string | null;
  bin: string | null;
  iin: string | null;
  director: string | null;
  accountant: string | null;
  shipmentResponsibleName: string | null;
  shipmentResponsiblePosition: string | null;
  transportOrganization: string | null;
  attorneyNumber: string | null;
  attorneyDate: string | null;
  attorneyIssuedBy: string | null;
};

type TemplateLine = {
  seq: number;
  description: string;
  nomenclature: string;
  unit: string;
  qtyToRelease: number;
  qtyReleased: number;
  price: number;
  amount: number;
  vat: number;
};

const TEMPLATE_PATH = fileURLToPath(new URL('../../../templates/z2_invoice_template.xlsx', import.meta.url));
const DATA_ROW_START = 24;

const GROUPS = {
  seq: [1, 2] as const,
  description: [3, 14] as const,
  nomenclature: [15, 19] as const,
  unit: [20, 22] as const,
  qtyToRelease: [23, 27] as const,
  qtyReleased: [28, 31] as const,
  price: [32, 37] as const,
  amount: [38, 43] as const,
  vat: [44, 49] as const,
};

function clonePlain<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString('ru-RU');
}

function chooseTaxId(org: TemplateOrg): string {
  return org.bin?.trim() || org.iin?.trim() || '';
}

function chooseOrgDisplayName(org: TemplateOrg): string {
  return org.legalName?.trim() || org.name.trim();
}

function chooseResponsiblePerson(org: TemplateOrg): string {
  return org.shipmentResponsibleName?.trim() || org.director?.trim() || org.accountant?.trim() || '';
}

function chooseApproverPosition(org: TemplateOrg): string {
  if (org.shipmentResponsiblePosition?.trim()) return org.shipmentResponsiblePosition.trim();
  if (org.director?.trim()) return 'Руководитель';
  if (org.accountant?.trim()) return 'Бухгалтер';
  return '';
}

function chooseTransportOrganization(org: TemplateOrg): string {
  return org.transportOrganization?.trim() || '';
}

function formatStoredDate(value: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (isoMatch) {
    return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`;
  }

  return trimmed;
}

function buildAttorneyReference(org: TemplateOrg): string {
  const number = org.attorneyNumber?.trim() || '';
  const date = formatStoredDate(org.attorneyDate);

  if (!number && !date) {
    return '№_____________ от "____"_____________________ 20___ года';
  }

  if (number && date) return `№ ${number} от ${date}`;
  if (number) return `№ ${number}`;
  return `от ${date}`;
}

function chooseRecipientName(orders: TemplateOrder[]): string {
  const uniqueNames = [...new Set(orders.map((order) => order.clientName.trim()).filter(Boolean))];
  const uniquePhones = [...new Set(
    orders.map((order) => (order.clientPhone?.trim() || order.clientPhoneForeign?.trim() || '')).filter(Boolean),
  )];

  if (uniqueNames.length === 0) return '';
  if (uniqueNames.length === 1) {
    const name = uniqueNames[0]!;
    const phone = uniquePhones.length === 1 ? uniquePhones[0] : '';
    return phone ? `${name}, ${phone}` : name;
  }

  return `${uniqueNames[0]} и др.`;
}

function formatItemDescription(item: TemplateOrder['items'][number]): string {
  const parts = [item.productName];
  if (item.size?.trim()) parts.push(`размер ${item.size.trim()}`);
  if (item.color?.trim()) parts.push(`цвет ${item.color.trim()}`);
  return parts.join(', ');
}

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function triadToWords(value: number, feminine: boolean): string {
  const hundreds = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
  const tens = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  const teens = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  const onesMale = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const onesFemale = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const ones = feminine ? onesFemale : onesMale;

  const words: string[] = [];
  const hundred = Math.floor(value / 100);
  const tenUnit = value % 100;
  const ten = Math.floor(tenUnit / 10);
  const unit = tenUnit % 10;

  if (hundred > 0) words.push(hundreds[hundred]!);
  if (tenUnit >= 10 && tenUnit <= 19) {
    words.push(teens[tenUnit - 10]!);
  } else {
    if (ten > 1) words.push(tens[ten]!);
    if (unit > 0) words.push(ones[unit]!);
  }

  return words.join(' ').trim();
}

function integerToRussianWords(value: number): string {
  if (value === 0) return 'ноль';

  const scales = [
    { forms: ['', '', ''], feminine: false },
    { forms: ['тысяча', 'тысячи', 'тысяч'], feminine: true },
    { forms: ['миллион', 'миллиона', 'миллионов'], feminine: false },
    { forms: ['миллиард', 'миллиарда', 'миллиардов'], feminine: false },
  ] as const;

  const parts: string[] = [];
  let remaining = Math.floor(value);
  let scaleIndex = 0;

  while (remaining > 0) {
    const triad = remaining % 1000;
    if (triad > 0) {
      const scale = scales[scaleIndex]!;
      const words = triadToWords(triad, scale.feminine);
      const scaleWord = scaleIndex === 0 ? '' : plural(triad, scale.forms as [string, string, string]);
      parts.unshift([words, scaleWord].filter(Boolean).join(' ').trim());
    }
    remaining = Math.floor(remaining / 1000);
    scaleIndex++;
  }

  return parts.join(' ').trim();
}

function capitalize(text: string): string {
  if (!text) return text;
  return text[0]!.toUpperCase() + text.slice(1);
}

function quantityToWords(quantity: number): string {
  return capitalize(integerToRussianWords(Math.trunc(quantity)));
}

function moneyToWordsKzt(amount: number): string {
  const normalized = Math.round(amount * 100) / 100;
  const tenge = Math.trunc(normalized);
  const tiyn = Math.round((normalized - tenge) * 100);
  return `${capitalize(integerToRussianWords(tenge))} тенге ${String(tiyn).padStart(2, '0')} тиын`;
}

function setCellText(
  ws: Worksheet,
  address: string,
  value: string,
  horizontal: 'left' | 'center' | 'right' = 'left',
  wrapText = false,
) {
  const cell = ws.getCell(address);
  cell.value = value;
  cell.font = { name: 'Arial', size: 8 };
  cell.alignment = { horizontal, vertical: 'middle', wrapText };
}

function setMergedText(
  ws: Worksheet,
  row: number,
  startCol: number,
  endCol: number,
  value: string | number,
  horizontal: 'left' | 'center' | 'right',
  numFmt?: string,
) {
  ws.mergeCells(row, startCol, row, endCol);
  for (let col = startCol; col <= endCol; col++) {
    const cell = ws.getCell(row, col);
    cell.font = { name: 'Arial', size: 8 };
    cell.alignment = { horizontal, vertical: 'middle', wrapText: true };
    cell.border = {
      top: { style: 'thin' },
      bottom: { style: 'thin' },
      left: { style: 'thin' },
      right: { style: 'thin' },
    };
    if (numFmt) cell.numFmt = numFmt;
  }
  ws.getRow(row).height = 11.1;
  ws.getCell(row, startCol).value = value;
}

function buildTemplateLines(orders: TemplateOrder[]): TemplateLine[] {
  const lines: TemplateLine[] = [];
  let seq = 1;

  for (const order of orders) {
    for (let itemIndex = 0; itemIndex < order.items.length; itemIndex++) {
      const item = order.items[itemIndex]!;
      const amount = Math.round(item.quantity * item.unitPrice * 100) / 100;
      lines.push({
        seq,
        description: formatItemDescription(item),
        nomenclature: `${order.orderNumber}-${itemIndex + 1}`,
        unit: 'шт',
        qtyToRelease: item.quantity,
        qtyReleased: item.quantity,
        price: item.unitPrice,
        amount,
        vat: 0,
      });
      seq++;
    }
  }

  return lines;
}

async function loadTemplateWorkbook() {
  const ExcelJS = await import('exceljs');
  const Workbook = ExcelJS.default?.Workbook ?? ExcelJS.Workbook;
  if (!Workbook) throw new Error('ExcelJS Workbook class not found');

  const wb = new Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);
  const sourceWs = wb.getWorksheet('TDSheet') ?? wb.worksheets[0];
  if (!sourceWs) throw new Error('Worksheet TDSheet not found in Z-2 template');

  const ws = wb.addWorksheet('TDSheet_WORK');
  ws.pageSetup = clonePlain(sourceWs.pageSetup);
  ws.headerFooter = clonePlain(sourceWs.headerFooter);
  ws.views = clonePlain(sourceWs.views);
  ws.properties = clonePlain(sourceWs.properties);

  for (let col = 1; col <= sourceWs.columnCount; col++) {
    const sourceColumn = sourceWs.getColumn(col);
    const targetColumn = ws.getColumn(col);
    targetColumn.width = sourceColumn.width;
    targetColumn.hidden = sourceColumn.hidden;
  }

  for (let row = 1; row <= 23; row++) {
    const sourceRow = sourceWs.getRow(row);
    const targetRow = ws.getRow(row);
    targetRow.height = sourceRow.height;
    targetRow.hidden = sourceRow.hidden;

    sourceRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const targetCell = targetRow.getCell(colNumber);
      targetCell.value = clonePlain(cell.value);
      targetCell.style = clonePlain(cell.style);
    });
  }

  for (const range of sourceWs.model.merges ?? []) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (!match) continue;
    const startRow = Number(match[2]);
    const endRow = Number(match[4]);
    if (startRow <= 23 && endRow <= 23) {
      ws.mergeCells(range);
    }
  }

  wb.removeWorksheet(sourceWs.id);
  ws.name = 'TDSheet';
  return { wb, ws };
}

async function getTemplateOrg(orgId: string): Promise<TemplateOrg> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      name: true,
      legalName: true,
      bin: true,
      iin: true,
      director: true,
      accountant: true,
      shipmentResponsibleName: true,
      shipmentResponsiblePosition: true,
      transportOrganization: true,
      attorneyNumber: true,
      attorneyDate: true,
      attorneyIssuedBy: true,
    },
  });

  if (!org) throw new NotFoundError('Organization', orgId);
  return org;
}

async function getTemplateOrder(orgId: string, orderId: string): Promise<TemplateOrder> {
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
  return order;
}

async function getTemplateOrders(orgId: string, orderIds: string[]): Promise<TemplateOrder[]> {
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
  return orders;
}

function populateTemplateHeader(
  ws: Worksheet,
  org: TemplateOrg,
  orders: TemplateOrder[],
  documentNumber: string,
  documentDate: Date,
) {
  const senderName = chooseOrgDisplayName(org);
  const recipientName = chooseRecipientName(orders);
  const responsible = chooseResponsiblePerson(org);
  const transportOrganization = chooseTransportOrganization(org);

  ws.getCell('N9').value = senderName;
  ws.getCell('AQ9').value = chooseTaxId(org);
  ws.getCell('AP13').value = documentNumber;
  ws.getCell('AT13').value = fmtDate(documentDate);

  ws.getCell('A19').value = senderName;
  ws.getCell('L19').value = recipientName;
  ws.getCell('W19').value = responsible;
  ws.getCell('AF19').value = transportOrganization;
  ws.getCell('AO19').value = '';
}

function populateTemplateTableAndFooter(
  ws: Worksheet,
  org: TemplateOrg,
  orders: TemplateOrder[],
  lines: TemplateLine[],
) {
  const totalRow = DATA_ROW_START + lines.length;
  const summaryRow = totalRow + 2;
  const approverRow = totalRow + 4;
  const approverCaptionRow = approverRow + 1;
  const attorneyRow = approverRow + 2;
  const accountantRow = totalRow + 8;
  const accountantCaptionRow = accountantRow + 1;
  const stampRow = accountantRow + 2;
  const releaseRow = totalRow + 12;
  const releaseCaptionRow = releaseRow + 1;

  lines.forEach((line, index) => {
    const row = DATA_ROW_START + index;
    setMergedText(ws, row, ...GROUPS.seq, line.seq, 'center');
    setMergedText(ws, row, ...GROUPS.description, line.description, 'left');
    setMergedText(ws, row, ...GROUPS.nomenclature, line.nomenclature, 'center');
    setMergedText(ws, row, ...GROUPS.unit, line.unit, 'center');
    setMergedText(ws, row, ...GROUPS.qtyToRelease, line.qtyToRelease, 'right', '#,##0');
    setMergedText(ws, row, ...GROUPS.qtyReleased, line.qtyReleased, 'right', '#,##0');
    setMergedText(ws, row, ...GROUPS.price, line.price, 'right', '#,##0.00');
    setMergedText(ws, row, ...GROUPS.amount, line.amount, 'right', '#,##0.00');
    setMergedText(ws, row, ...GROUPS.vat, line.vat, 'right', '#,##0.00');
  });

  const totalQuantity = lines.reduce((sum, line) => sum + line.qtyReleased, 0);
  const totalAmount = Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
  const totalVat = Math.round(lines.reduce((sum, line) => sum + line.vat, 0) * 100) / 100;
  const recipientName = chooseRecipientName(orders);
  const approverPosition = chooseApproverPosition(org);
  const approverName = chooseResponsiblePerson(org);
  const attorneyReference = buildAttorneyReference(org);
  const attorneyIssuedBy = org.attorneyIssuedBy?.trim() || '';
  const accountantName = org.accountant?.trim() || 'Не предусмотрен';

  ws.getRow(totalRow).height = 11.1;
  setCellText(ws, `V${totalRow}`, 'Итого', 'right');
  setMergedText(ws, totalRow, ...GROUPS.qtyToRelease, totalQuantity, 'right', '#,##0');
  setMergedText(ws, totalRow, ...GROUPS.qtyReleased, totalQuantity, 'right', '#,##0');
  setMergedText(ws, totalRow, ...GROUPS.price, 'х', 'center');
  setMergedText(ws, totalRow, ...GROUPS.amount, totalAmount, 'right', '#,##0.00');
  setMergedText(ws, totalRow, ...GROUPS.vat, totalVat, 'right', '#,##0.00');

  ws.getRow(summaryRow).height = 11.1;
  setCellText(ws, `A${summaryRow}`, 'Всего отпущено количество запасов (прописью)');
  setMergedText(ws, summaryRow, 14, 22, quantityToWords(totalQuantity), 'left');
  setMergedText(ws, summaryRow, 23, 30, 'на сумму (прописью), в KZT', 'left');
  setMergedText(ws, summaryRow, 31, 49, moneyToWordsKzt(totalAmount), 'left');

  setCellText(ws, `A${approverRow}`, 'Отпуск разрешил');
  setCellText(ws, `F${approverRow}`, approverPosition, 'center');
  setCellText(ws, `K${approverRow}`, '/', 'center');
  setCellText(ws, `Q${approverRow}`, '/', 'center');
  ws.mergeCells(approverRow, 18, approverRow, 24);
  setCellText(ws, `R${approverRow}`, approverName, 'center');
  setCellText(ws, `AA${approverRow}`, 'По доверенности');
  ws.mergeCells(approverRow, 32, approverRow, 48);
  setCellText(ws, `AF${approverRow}`, attorneyReference);

  ws.mergeCells(approverCaptionRow, 6, approverCaptionRow, 10);
  setCellText(ws, `F${approverCaptionRow}`, 'должность', 'center');
  ws.mergeCells(approverCaptionRow, 12, approverCaptionRow, 16);
  setCellText(ws, `L${approverCaptionRow}`, 'подпись', 'center');
  ws.mergeCells(approverCaptionRow, 18, approverCaptionRow, 24);
  setCellText(ws, `R${approverCaptionRow}`, 'расшифровка подписи', 'center');

  setCellText(ws, `AA${attorneyRow}`, 'выданной');
  ws.mergeCells(attorneyRow, 30, attorneyRow, 48);
  setCellText(ws, `AD${attorneyRow}`, attorneyIssuedBy);

  setCellText(ws, `A${accountantRow}`, 'Главный бухгалтер');
  setCellText(ws, `K${accountantRow}`, '/', 'center');
  ws.mergeCells(accountantRow, 12, accountantRow, 22);
  setCellText(ws, `L${accountantRow}`, accountantName, 'center');

  ws.mergeCells(accountantCaptionRow, 6, accountantCaptionRow, 10);
  setCellText(ws, `F${accountantCaptionRow}`, 'подпись', 'center');
  ws.mergeCells(accountantCaptionRow, 12, accountantCaptionRow, 22);
  setCellText(ws, `L${accountantCaptionRow}`, 'расшифровка подписи', 'center');

  setCellText(ws, `A${stampRow}`, 'М.П.');

  setCellText(ws, `A${releaseRow}`, 'Отпустил');
  setCellText(ws, `K${releaseRow}`, '/', 'center');
  setCellText(ws, `AA${releaseRow}`, 'Запасы получил');
  setCellText(ws, `AL${releaseRow}`, '/', 'center');

  ws.mergeCells(releaseCaptionRow, 6, releaseCaptionRow, 10);
  setCellText(ws, `F${releaseCaptionRow}`, 'подпись', 'center');
  ws.mergeCells(releaseCaptionRow, 12, releaseCaptionRow, 22);
  setCellText(ws, `L${releaseCaptionRow}`, 'расшифровка подписи', 'center');
  ws.mergeCells(releaseCaptionRow, 32, releaseCaptionRow, 37);
  setCellText(ws, `AF${releaseCaptionRow}`, 'подпись', 'center');
  ws.mergeCells(releaseCaptionRow, 39, releaseCaptionRow, 48);
  setCellText(ws, `AM${releaseCaptionRow}`, recipientName, 'center');
}

async function generateFromTemplate(
  orgId: string,
  orders: TemplateOrder[],
  documentNumber: string,
  documentDate: Date,
): Promise<Buffer> {
  const [org, { wb, ws }] = await Promise.all([
    getTemplateOrg(orgId),
    loadTemplateWorkbook(),
  ]);

  const lines = buildTemplateLines(orders);
  populateTemplateHeader(ws, org, orders, documentNumber, documentDate);
  populateTemplateTableAndFooter(ws, org, orders, lines);

  wb.creator = chooseOrgDisplayName(org);
  wb.created = new Date();

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function generateDefaultInvoiceTemplateXlsx(
  orgId: string,
  orderId: string,
): Promise<Buffer> {
  const order = await getTemplateOrder(orgId, orderId);
  return generateFromTemplate(orgId, [order], order.orderNumber, order.createdAt);
}

export async function generateDefaultBatchInvoiceTemplateXlsx(
  orgId: string,
  orderIds: string[],
  invoiceMeta?: { invoiceNumber: string; createdAt: Date },
): Promise<Buffer> {
  const orders = await getTemplateOrders(orgId, orderIds);
  const documentNumber = invoiceMeta?.invoiceNumber ?? orders[0]!.orderNumber;
  const documentDate = invoiceMeta?.createdAt ?? orders[0]!.createdAt;
  return generateFromTemplate(orgId, orders, documentNumber, documentDate);
}
