import { describe, expect, it } from 'vitest';
import { buildSheetRows, SHEET_HEADER } from '../sheets/row-builder.js';

const SAMPLE_ORDER = {
  id: 'ord_parity_1',
  orderNumber: 'ORD-323',
  createdAt: new Date('2026-03-31T08:00:00.000Z'),
  updatedAt: new Date('2026-03-31T09:30:00.000Z'),
  orderDate: new Date('2026-03-31T08:00:00.000Z'),
  status: 'new',
  paymentStatus: 'partial',
  urgency: 'urgent',
  isDemandingClient: true,
  clientName: 'Айгүл',
  clientPhone: '+7 (777)-777-77-77',
  city: 'Алматы',
  streetAddress: 'Абая 10, кв 5',
  postalCode: '050000',
  deliveryType: 'Курьер по городу',
  source: 'Instagram',
  dueDate: new Date('2026-04-02T08:00:00.000Z'),
  expectedPaymentMethod: 'Kaspi QR',
  totalAmount: 165000,
  paidAmount: 60000,
  orderDiscount: 5000,
  deliveryFee: 2000,
  bankCommissionPercent: 1,
  bankCommissionAmount: 1500,
  internalNote: 'Позвонить перед отправкой',
  shippingNote: 'Домофон не работает',
  sourceRequestId: 'req_9',
  paymentBreakdown: {
    cash: 30000,
    kaspi_terminal: 30000,
  },
  items: [
    {
      position: 1,
      productName: 'Шапан',
      color: 'Синий',
      gender: 'муж',
      length: '130',
      size: '52',
      quantity: 2,
      unitPrice: 75000,
      itemDiscount: 3000,
      workshopNotes: 'Укоротить рукав',
    },
    {
      position: 2,
      productName: 'Камзол',
      color: 'Черный',
      gender: 'жен',
      length: '125',
      size: '48',
      quantity: 1,
      unitPrice: 15000,
      itemDiscount: 0,
      workshopNotes: '',
    },
  ],
  payments: [
    { method: 'cash', amount: 30000 },
    { method: 'kaspi_terminal', amount: 30000 },
  ],
  attachments: [
    { originalName: 'receipt-1.jpg', filename: 'att_1.jpg' },
    { originalName: 'measurements.pdf', filename: 'att_2.pdf' },
  ],
};

describe('buildSheetRows', () => {
  it('matches the corrected Google Sheets header layout through AK', () => {
    expect(SHEET_HEADER).toHaveLength(38);
    expect(SHEET_HEADER[0]).toBe('Номер заказа 1');
    expect(SHEET_HEADER[3]).toBe('Номер заказа 2');
    expect(SHEET_HEADER[10]).toBe('Название Товара');
    expect(SHEET_HEADER[24]).toBe('Способы оплаты');
    expect(SHEET_HEADER[36]).toBe('');
    expect(SHEET_HEADER[37]).toBe('__order_id');
  });

  it('builds one sheet row per order item', () => {
    const rows = buildSheetRows(SAMPLE_ORDER);

    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row).toHaveLength(SHEET_HEADER.length));
  });

  it('keeps the base order number and adds item subnumbers', () => {
    const rows = buildSheetRows(SAMPLE_ORDER);

    expect(rows[0]?.[0]).toBe('ORD-323');
    expect(rows[0]?.[3]).toBe('ORD-323-1');
    expect(rows[1]?.[3]).toBe('ORD-323-2');
  });

  it('repeats order-level fields and splits item columns', () => {
    const rows = buildSheetRows(SAMPLE_ORDER);

    expect(rows[0]?.[6]).toBe('Instagram');
    expect(rows[0]?.[7]).toBe('Айгүл');
    expect(rows[0]?.[9]).toContain('#ORD-323-1');
    expect(rows[0]?.[9]).toContain('#ORD-323-2');
    expect(rows[0]?.[10]).toBe('Шапан');
    expect(rows[0]?.[11]).toBe('муж');
    expect(rows[0]?.[12]).toBe('52');
    expect(rows[0]?.[13]).toBe('Синий');
    expect(rows[0]?.[14]).toBe('130');
    expect(rows[1]?.[10]).toBe('Камзол');
  });

  it('fills the payment columns in the corrected layout', () => {
    const rows = buildSheetRows(SAMPLE_ORDER);

    expect(rows[0]?.[23]).toBe('Наличные, Kaspi Терминал');
    expect(rows[0]?.[24]).toBe('Смешанная');
    expect(rows[0]?.[25]).toBe('Наличные: 30 000 ₸ / Kaspi Терминал: 30 000 ₸');
    expect(rows[0]?.[26]).toBe(30000);
    expect(rows[0]?.[27]).toBe(30000);
    expect(rows[0]?.[28]).toBe('');
    expect(rows[0]?.[29]).toBe('');
  });

  it('appends a hidden technical order id after AK for stable resync', () => {
    const rows = buildSheetRows(SAMPLE_ORDER);

    expect(rows[0]?.[37]).toBe('ord_parity_1');
    expect(rows[1]?.[37]).toBe('ord_parity_1');
  });
});
