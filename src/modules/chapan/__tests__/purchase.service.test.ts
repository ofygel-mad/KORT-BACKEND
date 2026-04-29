import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as purchaseService from '../purchase.service';

const findFirstMock = vi.fn();

vi.mock('../../../lib/prisma.js', () => ({
  prisma: {
    chapanManualInvoice: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
    },
  },
}));

describe('purchase service XLSX export', () => {
  beforeEach(() => {
    findFirstMock.mockReset();
  });

  it('includes gender and length columns in generated XLSX', async () => {
    findFirstMock.mockResolvedValue({
      id: 'invoice-1',
      orgId: 'org-1',
      type: 'workshop',
      invoiceNum: 'MN-0001',
      title: 'Закуп ткани',
      notes: 'Проверка',
      createdById: 'user-1',
      createdByName: 'Owner',
      createdAt: '2026-04-29T09:00:00.000Z',
      items: [
        {
          id: 'item-1',
          productName: 'Чапан',
          gender: 'Женский',
          length: 'Длинный',
          color: 'Бордовый',
          size: '46',
          quantity: 3,
          unitPrice: 5000,
        },
      ],
    });

    const { buffer, filename } = await purchaseService.generateXlsx('org-1', 'invoice-1');

    expect(filename).toMatch(/zakup_/i);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];

    const headerValues = worksheet.getRow(4).values as Array<string | number | undefined>;
    expect(headerValues.slice(1, 10)).toEqual([
      '№',
      'Наименование',
      'Пол',
      'Длина',
      'Цвет',
      'Размер',
      'Кол-во',
      'Цена',
      'Итого',
    ]);

    const dataValues = worksheet.getRow(5).values as Array<string | number | undefined>;
    expect(dataValues[3]).toBe('Женский');
    expect(dataValues[4]).toBe('Длинный');
    expect(dataValues[5]).toBe('Бордовый');
    expect(dataValues[6]).toBe('46');
  });
});
