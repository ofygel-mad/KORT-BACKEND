export type InvoiceDocumentColumnKey =
  | 'itemNumber'
  | 'productName'
  | 'gender'
  | 'length'
  | 'size'
  | 'color'
  | 'quantity'
  | 'orders'
  | 'unitPrice'
  | 'lineTotal';

export interface InvoiceDocumentColumns {
  itemNumber: string;
  productName: string;
  gender: string;
  length: string;
  size: string;
  color: string;
  quantity: string;
  orders: string;
  unitPrice: string;
  lineTotal: string;
}

export interface InvoiceDocumentRow {
  id: string;
  itemNumber: string;
  productName: string;
  gender: string;
  length: string;
  size: string;
  color: string;
  quantity: number;
  orders: string;
  unitPrice: number;
  sourceOrders?: InvoiceDocumentSourceOrder[];
}

export interface InvoiceDocumentSourceOrder {
  orderId: string;
  orderNumber: string;
}

export interface InvoiceDocumentPayload {
  invoiceNumber?: string;
  invoiceDate: string;
  route: string;
  signatureLabel: string;
  columns: InvoiceDocumentColumns;
  rows: InvoiceDocumentRow[];
}

interface OrderItemSource {
  productName: string;
  fabric?: string | null;
  size: string;
  quantity: number;
  unitPrice: number;
  color?: string | null;
}

interface OrderSource {
  id: string;
  orderNumber: string;
  items: OrderItemSource[];
}

interface BuildInvoiceDocumentSource {
  invoiceNumber?: string;
  createdAt: Date;
  orders: OrderSource[];
}

const DEFAULT_COLUMNS: InvoiceDocumentColumns = {
  itemNumber: '№ товара',
  productName: 'Товар',
  gender: 'Муж/Жен',
  length: 'Длина изделия',
  size: 'Размер',
  color: 'Цвет',
  quantity: 'Кол.во',
  orders: 'Заказы',
  unitPrice: 'Цена',
  lineTotal: 'Сумма',
};

function detectGender(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('муж')) return 'муж';
  if (normalized.includes('жен')) return 'жен';
  return '';
}

function extractInvoiceRoute(invoiceNumber?: string): string {
  if (!invoiceNumber) return '';
  const match = invoiceNumber.match(/-(\d+)$/);
  return match?.[1] ?? '';
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const normalized = typeof value === 'string' ? Number(value.replace(/\s+/g, '').replace(',', '.')) : Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeKeyPart(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ru-RU');
}

function normalizeSourceOrders(value: unknown): InvoiceDocumentSourceOrder[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const unique = new Map<string, InvoiceDocumentSourceOrder>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const source = entry as Partial<InvoiceDocumentSourceOrder>;
    const orderId = normalizeString(source.orderId).trim();
    const orderNumber = normalizeString(source.orderNumber).trim();
    if (!orderId || !orderNumber || unique.has(orderId)) continue;
    unique.set(orderId, { orderId, orderNumber });
  }

  return Array.from(unique.values());
}

function formatOrderSourceLabel(sourceOrders: InvoiceDocumentSourceOrder[]): string {
  return sourceOrders.map((source) => source.orderNumber).join(' / ');
}

export function buildInvoiceDocumentPayload(source: BuildInvoiceDocumentSource): InvoiceDocumentPayload {
  // Group identical items only when all document-significant fields match.
  const groupMap = new Map<string, {
    productName: string;
    size: string;
    color: string;
    unitPrice: number;
    totalQuantity: number;
    sourceOrders: InvoiceDocumentSourceOrder[];
    firstOrderId: string;
  }>();

  for (const order of source.orders) {
    for (const item of order.items) {
      const key = [
        normalizeKeyPart(item.productName),
        normalizeKeyPart(item.fabric),
        normalizeKeyPart(item.size),
        normalizeKeyPart(item.color),
        item.unitPrice,
      ].join('|');
      const existing = groupMap.get(key);
      if (existing) {
        existing.totalQuantity += item.quantity;
        if (!existing.sourceOrders.some((sourceOrder) => sourceOrder.orderId === order.id)) {
          existing.sourceOrders.push({
            orderId: order.id,
            orderNumber: order.orderNumber,
          });
        }
      } else {
        groupMap.set(key, {
          productName: item.productName,
          size: item.size,
          color: item.color ?? '',
          unitPrice: item.unitPrice,
          totalQuantity: item.quantity,
          sourceOrders: [{
            orderId: order.id,
            orderNumber: order.orderNumber,
          }],
          firstOrderId: order.id,
        });
      }
    }
  }

  const rows: InvoiceDocumentRow[] = Array.from(groupMap.values()).map((group, index) => ({
    id: `${group.firstOrderId}:${index}`,
    itemNumber: String(index + 1),
    productName: group.productName,
    gender: detectGender(group.productName),
    length: 'Стандарт',
    size: group.size,
    color: group.color,
    quantity: group.totalQuantity,
    orders: formatOrderSourceLabel(group.sourceOrders),
    unitPrice: group.unitPrice,
    sourceOrders: group.sourceOrders,
  }));

  return {
    invoiceNumber: source.invoiceNumber,
    invoiceDate: toDateInputValue(source.createdAt),
    route: extractInvoiceRoute(source.invoiceNumber),
    signatureLabel: 'Подпись',
    columns: { ...DEFAULT_COLUMNS },
    rows,
  };
}

export function normalizeInvoiceDocumentPayload(
  payload: unknown,
  fallback: InvoiceDocumentPayload,
): InvoiceDocumentPayload {
  const source = payload && typeof payload === 'object' ? payload as Partial<InvoiceDocumentPayload> : {};
  const rows = Array.isArray(source.rows) && source.rows.length > 0
    ? source.rows.map((row, index) => {
      const input = row && typeof row === 'object' ? row as Partial<InvoiceDocumentRow> : {};
      const sourceOrders = normalizeSourceOrders(input.sourceOrders);
      return {
        id: normalizeString(input.id, `${index}`),
        itemNumber: normalizeString(input.itemNumber, String(index + 1)),
        productName: normalizeString(input.productName),
        gender: normalizeString(input.gender),
        length: normalizeString(input.length, 'Стандарт'),
        size: normalizeString(input.size),
        color: normalizeString(input.color),
        quantity: toFiniteNumber(input.quantity, 0),
        orders: sourceOrders.length > 0
          ? formatOrderSourceLabel(sourceOrders)
          : normalizeString(input.orders),
        unitPrice: toFiniteNumber(input.unitPrice, 0),
        sourceOrders: sourceOrders.length > 0 ? sourceOrders : undefined,
      };
    })
    : fallback.rows;

  return {
    invoiceNumber: fallback.invoiceNumber,
    invoiceDate: normalizeString(source.invoiceDate, fallback.invoiceDate),
    route: normalizeString(source.route, fallback.route),
    signatureLabel: normalizeString(source.signatureLabel, fallback.signatureLabel),
    columns: {
      itemNumber: normalizeString(source.columns?.itemNumber, fallback.columns.itemNumber),
      productName: normalizeString(source.columns?.productName, fallback.columns.productName),
      gender: normalizeString(source.columns?.gender, fallback.columns.gender),
      length: normalizeString(source.columns?.length, fallback.columns.length),
      size: normalizeString(source.columns?.size, fallback.columns.size),
      color: normalizeString(source.columns?.color, fallback.columns.color),
      quantity: normalizeString(source.columns?.quantity, fallback.columns.quantity),
      orders: normalizeString(source.columns?.orders, fallback.columns.orders),
      unitPrice: normalizeString(source.columns?.unitPrice, fallback.columns.unitPrice),
      lineTotal: normalizeString(source.columns?.lineTotal, fallback.columns.lineTotal),
    },
    rows: rows.map((row, index) => ({
      ...row,
      itemNumber: row.itemNumber || String(index + 1),
    })),
  };
}

export function calculateInvoiceDocumentTotals(document: InvoiceDocumentPayload) {
  return document.rows.reduce(
    (acc, row) => {
      acc.totalQuantity += toFiniteNumber(row.quantity, 0);
      acc.totalAmount += toFiniteNumber(row.quantity, 0) * toFiniteNumber(row.unitPrice, 0);
      return acc;
    },
    { totalQuantity: 0, totalAmount: 0 },
  );
}
