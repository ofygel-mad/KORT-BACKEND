import { calculateChapanOrderFinancials } from '../financials.js';
import { formatOrderItemNumber } from '../order-item-number.js';

export type SheetCellValue = string | number;

export const SHEET_HEADER = [
  'Номер заказа 1',
  'Количество позиций',
  'Количество единиц',
  'Номер заказа 2',
  'Дата создания',
  'Дата заказа',
  'Источник',
  'Клиент',
  'Телефон',
  'Позиции (коротко)',
  'Название Товара',
  'Пол',
  'Размер',
  'Цвет',
  'Длина Изделия',
  'Итого по позициям',
  'Скидка заказа',
  'Доставка',
  'Комиссия банка %',
  'Комиссия банка сумма',
  'Итого к оплате',
  'Оплачено',
  'Остаток',
  'Способы оплаты',
  'Способы оплаты',
  'Смешанная разбивка',
  'Наличные',
  'Kaspi Терминал',
  'Перевод',
  'Халык',
  'Тип доставки',
  'Город',
  'Индекс',
  'Улица / адрес',
  'Срочность',
  'Требовательный',
  '',
  '__order_id',
] as const;

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-KZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function fmtMoney(value: number | null | undefined): string {
  const amount = Number(value ?? 0);
  return amount > 0 ? `${amount.toLocaleString('ru-KZ')} ₸` : '';
}

function compact(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function paymentLabel(method: string): string {
  if (method === 'cash') return 'Наличные';
  if (method === 'card') return 'Карта';
  if (method === 'kaspi_qr') return 'Kaspi QR';
  if (method === 'kaspi_terminal') return 'Kaspi Терминал';
  if (method === 'transfer') return 'Перевод';
  if (method === 'halyk') return 'Халык';
  if (method === 'mixed') return 'Смешанная';
  return method;
}

function buildItemPrimaryLine(item: {
  productName?: string | null;
  color?: string | null;
  gender?: string | null;
}): string {
  const parts = [compact(item.productName), compact(item.color)].filter(Boolean);
  const line = parts.join(' - ');
  const gender = compact(item.gender);
  return line && gender ? `${line} (${gender})` : line;
}

function buildShortItemSummary(orderNumber: string, items: Array<{
  position?: number | null;
  productName?: string | null;
  color?: string | null;
  gender?: string | null;
  size?: string | null;
  length?: string | null;
  quantity?: number | null;
}>): string {
  return items.map((item) => {
    const itemNumber = formatOrderItemNumber(orderNumber, item.position);
    return [
      `#${itemNumber}`,
      buildItemPrimaryLine(item),
      compact(item.size),
      item.length ? `дл. ${compact(item.length)}` : '',
      (item.quantity ?? 0) > 1 ? `× ${item.quantity}` : '',
    ].filter(Boolean).join(' · ');
  }).join('; ');
}

function normalizePaymentBreakdown(input: SheetOrderPayload): Record<string, number> {
  const sums = new Map<string, number>();
  const add = (method: string, amount: number | null | undefined) => {
    const numericAmount = Number(amount ?? 0);
    if (!method || !Number.isFinite(numericAmount) || numericAmount <= 0) return;
    sums.set(method, (sums.get(method) ?? 0) + numericAmount);
  };

  for (const [method, amount] of Object.entries(input.paymentBreakdown ?? {})) {
    add(method, amount);
  }

  if (sums.size > 0) {
    return Object.fromEntries(sums.entries());
  }

  for (const payment of input.payments) {
    if (payment.method === 'mixed') continue;
    add(payment.method, payment.amount);
  }

  return Object.fromEntries(sums.entries());
}

function listPaymentMethods(input: SheetOrderPayload, breakdown: Record<string, number>): string[] {
  const methods = new Set<string>();

  Object.entries(breakdown).forEach(([method, amount]) => {
    if (amount > 0) {
      methods.add(method);
    }
  });

  input.payments.forEach((payment) => {
    if (payment.method === 'mixed') return;
    methods.add(payment.method);
  });

  if (methods.size === 0 && input.payments.some((payment) => payment.method === 'mixed')) {
    methods.add('mixed');
  }

  return [...methods];
}

function buildLegacyPaymentMethods(input: SheetOrderPayload, breakdown: Record<string, number>): string {
  return listPaymentMethods(input, breakdown).map(paymentLabel).join(', ');
}

function buildPrimaryPaymentMethod(input: SheetOrderPayload, breakdown: Record<string, number>): string {
  const methods = listPaymentMethods(input, breakdown);
  if (methods.length > 1) return paymentLabel('mixed');
  if (methods.length === 1) return paymentLabel(methods[0] ?? '');
  return compact(input.expectedPaymentMethod);
}

function buildMixedBreakdown(input: SheetOrderPayload, breakdown: Record<string, number>): string {
  const parts = Object.entries(breakdown)
    .filter(([, amount]) => amount > 0)
    .map(([method, amount]) => `${paymentLabel(method)}: ${amount.toLocaleString('ru-KZ')} ₸`);

  if (parts.length > 0) {
    return parts.join(' / ');
  }

  return input.payments
    .filter((payment) => payment.method !== 'mixed' && payment.amount > 0)
    .map((payment) => `${paymentLabel(payment.method)}: ${payment.amount.toLocaleString('ru-KZ')} ₸`)
    .join(' / ');
}

function getPaymentBucketAmount(
  bucket: 'cash' | 'kaspi_terminal' | 'transfer' | 'halyk',
  breakdown: Record<string, number>,
): number | '' {
  if (bucket === 'kaspi_terminal') {
    const kaspiAmount = (breakdown.kaspi_terminal ?? 0) + (breakdown.kaspi_qr ?? 0) + (breakdown.card ?? 0);
    return kaspiAmount > 0 ? kaspiAmount : '';
  }

  const amount = breakdown[bucket] ?? 0;
  return amount > 0 ? amount : '';
}

function buildUrgencyLabel(urgency: string | null | undefined): string {
  return urgency === 'urgent' ? 'Срочный' : 'Обычный';
}

export type SheetOrderPayload = {
  id: string;
  orderNumber: string;
  createdAt: Date;
  updatedAt: Date;
  orderDate?: Date | null;
  status: string;
  paymentStatus: string;
  urgency?: string | null;
  isDemandingClient?: boolean | null;
  clientName: string;
  clientPhone: string;
  city?: string | null;
  streetAddress?: string | null;
  postalCode?: string | null;
  deliveryType?: string | null;
  source?: string | null;
  dueDate?: Date | null;
  expectedPaymentMethod?: string | null;
  totalAmount: number;
  paidAmount: number;
  orderDiscount?: number | null;
  deliveryFee?: number | null;
  bankCommissionPercent?: number | null;
  bankCommissionAmount?: number | null;
  internalNote?: string | null;
  shippingNote?: string | null;
  sourceRequestId?: string | null;
  paymentBreakdown?: Record<string, number> | null;
  items: Array<{
    position?: number | null;
    productName?: string | null;
    color?: string | null;
    gender?: string | null;
    length?: string | null;
    size?: string | null;
    quantity?: number | null;
    unitPrice?: number | null;
    itemDiscount?: number | null;
    workshopNotes?: string | null;
  }>;
  payments: Array<{ method: string; amount: number }>;
  attachments: Array<{ originalName?: string | null; filename?: string | null }>;
};

export function buildSheetRows(order: SheetOrderPayload): SheetCellValue[][] {
  const itemsSubtotal = order.items.reduce(
    (sum, item) => sum + (item.quantity ?? 0) * (item.unitPrice ?? 0),
    0,
  );
  const financials = calculateChapanOrderFinancials({
    itemsSubtotal,
    orderDiscount: order.orderDiscount,
    deliveryFee: order.deliveryFee,
    bankCommissionPercent: order.bankCommissionPercent,
    bankCommissionAmount: order.bankCommissionAmount,
  });
  const itemCount = order.items.length;
  const unitCount = order.items.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const summary = buildShortItemSummary(order.orderNumber, order.items);
  const breakdown = normalizePaymentBreakdown(order);
  const items = order.items.length > 0
    ? order.items
    : [{ position: null, productName: '', color: '', gender: '', length: '', size: '', quantity: 0 }];

  return items.map((item) => [
    compact(order.orderNumber),
    itemCount,
    unitCount,
    formatOrderItemNumber(order.orderNumber, item.position),
    fmtDate(order.createdAt),
    fmtDate(order.orderDate ?? null),
    compact(order.source),
    compact(order.clientName),
    compact(order.clientPhone),
    summary,
    compact(item.productName),
    compact(item.gender),
    compact(item.size),
    compact(item.color),
    compact(item.length),
    fmtMoney(itemsSubtotal),
    fmtMoney(order.orderDiscount ?? 0),
    fmtMoney(order.deliveryFee ?? 0),
    order.bankCommissionPercent ? String(order.bankCommissionPercent) : '',
    fmtMoney(order.bankCommissionAmount ?? 0),
    fmtMoney(financials.totalDue),
    fmtMoney(order.paidAmount),
    fmtMoney(Math.max(0, financials.totalDue - order.paidAmount)),
    buildLegacyPaymentMethods(order, breakdown),
    buildPrimaryPaymentMethod(order, breakdown),
    buildMixedBreakdown(order, breakdown),
    getPaymentBucketAmount('cash', breakdown),
    getPaymentBucketAmount('kaspi_terminal', breakdown),
    getPaymentBucketAmount('transfer', breakdown),
    getPaymentBucketAmount('halyk', breakdown),
    compact(order.deliveryType),
    compact(order.city),
    compact(order.postalCode),
    compact(order.streetAddress),
    buildUrgencyLabel(order.urgency),
    order.isDemandingClient ? 'Да' : '',
    '',
    order.id,
  ]);
}
