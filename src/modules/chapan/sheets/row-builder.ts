/**
 * Google Sheets row schema for Chapan orders.
 *
 * Separated from transport/retry logic (sheets.sync.ts) so the schema is
 * independently versioned, testable, and not coupled to the Prisma client.
 *
 * Each column is documented inline. The schema is append-only: new columns
 * go at the end so existing spreadsheets don't shift their column layout.
 */

export const SHEET_HEADER = [
  'ID заказа',            // A — idempotency key
  'Номер заказа',         // B
  'Дата создания',        // C
  'Дата заказа',          // D
  'Статус',               // E
  'Статус оплаты',        // F
  'Срочность',            // G
  'Требовательный',       // H
  'Клиент',               // I
  'Телефон',              // J
  'Город',                // K
  'Улица / адрес',        // L
  'Индекс',               // M
  'Тип доставки',         // N
  'Источник',             // O
  'Срок готовности',      // P
  'Ожидаемый способ оплаты', // Q
  'Позиции (коротко)',    // R — human-readable summary
  'Позиции JSON',         // S — full machine-readable payload
  'Количество позиций',   // T
  'Количество единиц',    // U
  'Итого по позициям',    // V
  'Скидка заказа',        // W
  'Доставка',             // X
  'Комиссия банка %',     // Y
  'Комиссия банка сумма', // Z
  'Итого к оплате',       // AA
  'Оплачено',             // AB
  'Остаток',              // AC
  'Способы оплаты',       // AD
  'Смешанная разбивка',   // AE
  'Внутренняя заметка',   // AF
  'Примечание к доставке',// AG
  'Вложений',             // AH
  'Имена вложений',       // AI
  'Комментарий цеху',     // AJ — aggregated workshopNotes across items
  'Source request id',    // AK
  'Обновлено',            // AL
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-KZ', {
    day: '2-digit', month: '2-digit', year: 'numeric',
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
  if (method === 'cash')             return 'Наличные';
  if (method === 'card')             return 'Карта';
  if (method === 'kaspi_qr')         return 'Kaspi QR';
  if (method === 'kaspi_terminal')   return 'Kaspi Терминал';
  if (method === 'transfer')         return 'Перевод';
  if (method === 'halyk')            return 'Халык';
  if (method === 'mixed')            return 'Смешанный';
  return method;
}

function buildItemPrimaryLine(item: {
  productName?: string | null;
  color?: string | null;
  gender?: string | null;
}): string {
  const parts = [compact(item.productName), compact(item.color)].filter(Boolean);
  const line  = parts.join(' - ');
  const gender = compact(item.gender);
  return line && gender ? `${line} (${gender})` : line;
}

function buildShortItemSummary(items: Array<{
  productName?: string | null;
  color?: string | null;
  gender?: string | null;
  size?: string | null;
  length?: string | null;
  quantity?: number | null;
}>): string {
  return items.map((item) => {
    return [
      buildItemPrimaryLine(item),
      compact(item.size),
      item.length ? `дл. ${compact(item.length)}` : '',
      (item.quantity ?? 0) > 1 ? `× ${item.quantity}` : '',
    ].filter(Boolean).join(' · ');
  }).join('; ');
}

function buildItemsJson(items: Array<{
  productName?: string | null;
  color?: string | null;
  gender?: string | null;
  length?: string | null;
  size?: string | null;
  quantity?: number | null;
  unitPrice?: number | null;
  itemDiscount?: number | null;
  workshopNotes?: string | null;
}>): string {
  return JSON.stringify(items.map((item) => ({
    productName:   compact(item.productName),
    color:         compact(item.color),
    gender:        compact(item.gender),
    length:        compact(item.length),
    size:          compact(item.size),
    quantity:      item.quantity   ?? 0,
    unitPrice:     item.unitPrice  ?? 0,
    itemDiscount:  item.itemDiscount ?? 0,
    workshopNotes: compact(item.workshopNotes),
  })));
}

function buildPaymentMethods(payments: Array<{ method: string }>): string {
  return [...new Set(payments.map(p => paymentLabel(p.method)))].join(', ');
}

function buildMixedBreakdown(payments: Array<{ method: string; amount: number }>): string {
  return payments
    .filter(p => p.method !== 'mixed' && p.amount > 0)
    .map(p => `${paymentLabel(p.method)}: ${p.amount.toLocaleString('ru-KZ')} ₸`)
    .join(' / ');
}

function buildAttachmentNames(attachments: Array<{ originalName?: string | null; filename?: string | null }>): string {
  return attachments
    .map(a => compact(a.originalName) || compact(a.filename))
    .filter(Boolean)
    .join('; ');
}

function buildWorkshopNotes(items: Array<{ workshopNotes?: string | null; productName?: string | null }>): string {
  return items
    .filter(i => compact(i.workshopNotes))
    .map(i => `${compact(i.productName) || 'Позиция'}: ${compact(i.workshopNotes)}`)
    .join(' | ');
}

// ── Public types ─────────────────────────────────────────────────────────────

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
  items: Array<{
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

// ── Row builder ───────────────────────────────────────────────────────────────

export function buildSheetRow(order: SheetOrderPayload): string[] {
  const itemsSubtotal = order.items.reduce(
    (sum, i) => sum + (i.quantity ?? 0) * (i.unitPrice ?? 0),
    0,
  );
  const itemCount = order.items.length;
  const unitCount = order.items.reduce((sum, i) => sum + (i.quantity ?? 0), 0);

  return [
    order.id,
    order.orderNumber,
    fmtDate(order.createdAt),
    fmtDate(order.orderDate ?? null),
    order.status,
    order.paymentStatus,
    order.urgency === 'urgent' ? 'Срочный' : 'Обычный',
    order.isDemandingClient ? 'Да' : '',
    compact(order.clientName),
    compact(order.clientPhone),
    compact(order.city),
    compact(order.streetAddress),
    compact(order.postalCode),
    compact(order.deliveryType),
    compact(order.source),
    fmtDate(order.dueDate ?? null),
    compact(order.expectedPaymentMethod),
    buildShortItemSummary(order.items),
    buildItemsJson(order.items),
    String(itemCount),
    String(unitCount),
    fmtMoney(itemsSubtotal),
    fmtMoney(order.orderDiscount ?? 0),
    fmtMoney(order.deliveryFee ?? 0),
    order.bankCommissionPercent ? String(order.bankCommissionPercent) : '',
    fmtMoney(order.bankCommissionAmount ?? 0),
    fmtMoney(order.totalAmount),
    fmtMoney(order.paidAmount),
    fmtMoney(order.totalAmount - order.paidAmount),
    buildPaymentMethods(order.payments),
    buildMixedBreakdown(order.payments),
    compact(order.internalNote),
    compact(order.shippingNote),
    order.attachments.length > 0 ? String(order.attachments.length) : '',
    buildAttachmentNames(order.attachments),
    buildWorkshopNotes(order.items),
    compact(order.sourceRequestId),
    fmtDate(order.updatedAt),
  ];
}
