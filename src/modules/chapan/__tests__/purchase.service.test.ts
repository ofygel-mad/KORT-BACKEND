import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as purchaseService from '../purchase.service';

const findFirstMock = vi.fn();
const findUniqueMock = vi.fn();

vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    chapanManualInvoice: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
    organization: {
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
  },
}));

describe('purchase service XLSX export', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
    findUniqueMock.mockReset();
  });

  it('keeps purchase exports in KZT without ruble symbols', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invoice-1',
      orgId: 'org-1',
      type: 'workshop',
      invoiceNum: '\u041c\u041d-0001',
      title: 'Test purchase',
      notes: 'Verification',
      createdById: 'user-1',
      createdByName: 'Owner',
      createdAt: '2026-04-29T09:00:00.000Z',
      items: [
        {
          id: 'item-1',
          productName: 'Chapan',
          gender: '\u0416\u0435\u043d\u0441\u043a\u0438\u0439',
          length: '\u0414\u043b\u0438\u043d\u043d\u044b\u0439',
          color: '\u0411\u043e\u0440\u0434\u043e\u0432\u044b\u0439',
          size: '46',
          quantity: 3,
          unitPrice: 5000,
        },
      ],
    });
    findUniqueMock.mockResolvedValue({ currency: 'KZT' });

    const { buffer, filename } = await purchaseService.generateXlsx('org-1', 'invoice-1');

    expect(filename).toBe('zakup_\u041c\u041d_0001.xlsx');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];

    const headerValues = worksheet.getRow(4).values as Array<string | number | undefined>;
    expect(headerValues.slice(1, 10)).toEqual([
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

    const dataValues = worksheet.getRow(5).values as Array<string | number | undefined>;
    expect(dataValues[3]).toBe('\u0416\u0435\u043d\u0441\u043a\u0438\u0439');
    expect(dataValues[4]).toBe('\u0414\u043b\u0438\u043d\u043d\u044b\u0439');
    expect(dataValues[5]).toBe('\u0411\u043e\u0440\u0434\u043e\u0432\u044b\u0439');
    expect(dataValues[6]).toBe('46');

    expect(worksheet.getCell('H5').numFmt).toContain('\u20b8');
    expect(worksheet.getCell('I5').numFmt).toContain('\u20b8');
    expect(worksheet.getCell('H5').numFmt).not.toContain('\u20bd');
    expect(worksheet.getCell('I5').numFmt).not.toContain('\u20bd');

    const totalValue = String(worksheet.getCell('I7').value ?? '');
    expect(totalValue).toContain('\u20b8');
    expect(totalValue).not.toContain('\u20bd');
  });
});
