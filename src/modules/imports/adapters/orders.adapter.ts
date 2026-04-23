/**
 * adapters/orders.adapter.ts
 *
 * Imports production orders from scanned file rows.
 * Creates ChapanClient + ChapanOrder + ChapanOrderItem records.
 * Also emits accounting sync event per payment.
 */

import { prisma } from '../../../lib/prisma.js';
import { syncChapanPayment } from '../../accounting/accounting.sync.js';

export interface OrderRow {
  order_number?: string;
  customer_name?: string;
  phone?: string;
  product_name?: string;
  size?: string;
  color?: string;
  gender?: string;
  quantity?: number | string;
  unit_price?: number | string;
  total_amount?: number | string;
  payment_method?: string;
  cost_price?: number | string;
  status?: string;
  created_at?: string;
  due_date?: string;
  city?: string;
  manager_name?: string;
  notes?: string;
  discount?: number | string;
}

function parseNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  return parseFloat(String(v).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
}

function parseDate(v: unknown): Date | undefined {
  if (!v) return undefined;
  const s = String(v).trim();
  // dd.mm.yyyy
  const ddmm = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ddmm) return new Date(`${ddmm[3]}-${ddmm[2]}-${ddmm[1]}`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? undefined : d;
}

function mapStatus(raw?: string): string {
  if (!raw) return 'new';
  const s = raw.toLowerCase();
  if (s.includes('да') || s.includes('yes') || s.includes('готов') || s.includes('выполн')) return 'completed';
  if (s.includes('нет') || s.includes('в работ') || s.includes('произв')) return 'in_production';
  if (s.includes('отмен') || s.includes('cancel')) return 'cancelled';
  return 'new';
}

export interface AdapterResult {
  created: number;
  skipped: number;
  errors: string[];
}

export async function importOrders(
  orgId: string,
  rows: OrderRow[],
  authorName: string,
): Promise<AdapterResult> {
  const result: AdapterResult = { created: 0, skipped: 0, errors: [] };

  // Group rows by order_number (one order can have multiple items)
  const orderGroups = new Map<string, OrderRow[]>();

  for (const row of rows) {
    const num = row.order_number?.trim() ?? `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!orderGroups.has(num)) orderGroups.set(num, []);
    orderGroups.get(num)!.push(row);
  }

  for (const [orderNumber, items] of orderGroups) {
    try {
      // Check if order already exists
      const existing = await prisma.chapanOrder.findFirst({
        where: { orgId, orderNumber },
      });
      if (existing) {
        result.skipped++;
        continue;
      }

      const firstRow = items[0];
      if (!firstRow) {
        result.skipped++;
        continue;
      }
      const customerName = firstRow.customer_name?.trim() ?? 'Неизвестный';
      const phone = firstRow.phone?.trim() ?? '';

      // Find or create client
      let client = phone
        ? await prisma.chapanClient.findFirst({ where: { orgId, phone } })
        : null;

      if (!client) {
        client = await prisma.chapanClient.create({
          data: { orgId, fullName: customerName, phone: phone || '—' },
        });
      }

      const totalAmount = parseNum(firstRow.total_amount) || items.reduce((s, r) => s + parseNum(r.unit_price) * parseNum(r.quantity || 1), 0);
      const paidAmount = totalAmount; // assume paid if imported from a sales sheet

      const order = await prisma.chapanOrder.create({
        data: {
          orgId,
          orderNumber,
          clientId: client.id,
          clientName: customerName,
          clientPhone: phone || '—',
          status: mapStatus(firstRow.status),
          paymentStatus: totalAmount > 0 ? 'paid' : 'not_paid',
          totalAmount,
          paidAmount,
          dueDate: parseDate(firstRow.due_date),
          createdAt: parseDate(firstRow.created_at) ?? new Date(),
        },
      });

      // Create order items
      for (const row of items) {
        const qty = Math.max(1, Math.round(parseNum(row.quantity || 1)));
        const unitPrice = parseNum(row.unit_price);
        const productName = row.product_name?.trim() ?? 'Без названия';
        const size = row.size?.trim() ?? '—';

        await prisma.chapanOrderItem.create({
          data: {
            orderId: order.id,
            productName,
            size,
            quantity: qty,
            unitPrice,
            notes: [row.color, row.gender, row.notes].filter(Boolean).join(', ') || undefined,
          },
        });
      }

      // Emit accounting event for the payment
      if (paidAmount > 0 && firstRow.payment_method) {
        await syncChapanPayment({
          orgId,
          orderId: order.id,
          orderNumber,
          amount: paidAmount,
          method: firstRow.payment_method,
          clientName: customerName,
          authorName,
        });
      }

      result.created++;
    } catch (err) {
      result.errors.push(`Заказ ${orderNumber}: ${(err as Error).message}`);
    }
  }

  return result;
}
