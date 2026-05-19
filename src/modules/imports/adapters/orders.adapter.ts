/**
 * adapters/orders.adapter.ts
 *
 * Imports production orders from scanned file rows.
 * Creates ChapanClient + ChapanOrder + ChapanOrderItem records.
 * Also emits accounting sync event per payment.
 */

import { prisma } from '../../../lib/prisma.js';
import { syncChapanPayment } from '../../accounting/accounting.sync.js';
import { parseOrderItemNumber } from '../../chapan/order-item-number.js';

export interface OrderRow {
  order_number?: string;
  item_position?: number | string;
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
  const orderGroups = new Map<string, Array<OrderRow & { __rowIndex: number; __parsedPosition: number | null }>>();

  for (const [rowIndex, row] of rows.entries()) {
    const rawOrderNumber = row.order_number?.trim() ?? '';
    const parsed = rawOrderNumber ? parseOrderItemNumber(rawOrderNumber) : { orderNumber: '', position: null };
    const groupNumber = parsed.orderNumber || `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    if (!orderGroups.has(groupNumber)) orderGroups.set(groupNumber, []);
    orderGroups.get(groupNumber)!.push({ ...row, __rowIndex: rowIndex, __parsedPosition: parsed.position });
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
      const usedPositions = new Set<number>();
      const sortedRows = [...items].sort((left, right) => {
        const leftPosition = left.__parsedPosition ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.__parsedPosition ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) {
          return leftPosition - rightPosition;
        }
        return left.__rowIndex - right.__rowIndex;
      });

      for (const [itemIndex, row] of sortedRows.entries()) {
        const qty = Math.max(1, Math.round(parseNum(row.quantity || 1)));
        const unitPrice = parseNum(row.unit_price);
        const productName = row.product_name?.trim() ?? 'Без названия';
        const size = row.size?.trim() ?? '—';
        const explicitPosition = Math.max(0, Math.round(parseNum(row.item_position)));
        const parsedPosition = row.__parsedPosition;
        const fallbackPosition = itemIndex + 1;
        const preferredPositions: number[] = [];
        if (explicitPosition > 0) preferredPositions.push(explicitPosition);
        if (parsedPosition !== null && parsedPosition > 0) preferredPositions.push(parsedPosition);

        let position = preferredPositions.find((value) => !usedPositions.has(value));
        if (!position) {
          let candidate = fallbackPosition;
          while (usedPositions.has(candidate)) {
            candidate++;
          }
          position = candidate;
        }
        usedPositions.add(position);

        await prisma.chapanOrderItem.create({
          data: {
            orderId: order.id,
            position,
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
