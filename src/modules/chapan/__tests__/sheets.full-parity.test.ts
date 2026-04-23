/**
 * Full parity test for the Google Sheets row schema.
 *
 * Verifies that buildSheetRow exports the current order item contract,
 * including notes, item JSON payload, attachments, and sourceRequestId.
 */
import { describe, expect, it } from 'vitest';
import { buildSheetRow, SHEET_HEADER } from '../sheets/row-builder.js';

const SAMPLE_ORDER = {
  id: 'ord_parity_1',
  orderNumber: 'ЧП-777',
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
  items: [
    {
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
  ],
  payments: [
    { method: 'cash', amount: 30000 },
    { method: 'kaspi_qr', amount: 30000 },
  ],
  attachments: [
    { originalName: 'receipt-1.jpg', filename: 'att_1.jpg' },
    { originalName: 'measurements.pdf', filename: 'att_2.pdf' },
  ],
};

describe('buildSheetRow - full parity', () => {
  it('produces a row with the correct number of columns', () => {
    const row = buildSheetRow(SAMPLE_ORDER);
    expect(row).toHaveLength(SHEET_HEADER.length);
  });

  it('exports street address', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Абая 10, кв 5');
  });

  it('exports source', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Instagram');
  });

  it('exports expected payment method', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Kaspi QR');
  });

  it('exports attachment filenames joined by semicolon', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('receipt-1.jpg; measurements.pdf');
  });

  it('exports item primary line with dash separator inside short summary', () => {
    const row = buildSheetRow(SAMPLE_ORDER);
    const hasIt = row.some((cell) => cell.includes('Шапан - Синий (муж)'));
    expect(hasIt).toBe(true);
  });

  it('exports workshop notes per item', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Шапан: Укоротить рукав');
  });

  it('exports sourceRequestId', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('req_9');
  });

  it('exports urgency as readable string', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Срочный');
  });

  it('exports isDemandingClient as Да', () => {
    expect(buildSheetRow(SAMPLE_ORDER)).toContain('Да');
  });

  it('exports mixed-payment breakdown', () => {
    const row = buildSheetRow(SAMPLE_ORDER);
    const breakdown = row.find((cell) => cell.includes('Наличные') && cell.includes('Kaspi QR') && cell.includes('₸'));
    expect(breakdown).toBeDefined();
  });

  it('exports items JSON with the current item schema', () => {
    const row = buildSheetRow(SAMPLE_ORDER);
    const jsonCell = row.find((cell) => {
      try {
        const parsed = JSON.parse(cell);
        return Array.isArray(parsed);
      } catch {
        return false;
      }
    });

    expect(jsonCell).toBeDefined();
    const parsed = JSON.parse(jsonCell!);
    expect(parsed[0]).toMatchObject({
      productName: 'Шапан',
      color: 'Синий',
      gender: 'муж',
      length: '130',
      size: '52',
      quantity: 2,
      unitPrice: 75000,
      itemDiscount: 3000,
      workshopNotes: 'Укоротить рукав',
    });
  });
});
