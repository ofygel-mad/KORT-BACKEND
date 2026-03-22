/**
 * accounting.sync.ts
 *
 * Event-driven bridge: listens to business events from other modules
 * and automatically creates accounting entries.
 *
 * Usage: call registerAccountingSync(app) once in buildApp()
 * Other modules emit via emitAccountingEvent(type, payload)
 */

import { createEntry } from './accounting.service.js';

// ─────────────────────────────────────────────────────────────
//  Event bus (in-process, lightweight)
// ─────────────────────────────────────────────────────────────

type AccountingEventType =
  | 'deal.won'
  | 'deal.payment'
  | 'chapan_order.completed'
  | 'chapan_payment.added'
  | 'warehouse.movement_in'
  | 'warehouse.write_off';

interface AccountingEvent {
  type: AccountingEventType;
  orgId: string;
  payload: Record<string, unknown>;
}

type EventHandler = (event: AccountingEvent) => Promise<void>;
const handlers: EventHandler[] = [];

export function onAccountingEvent(handler: EventHandler) {
  handlers.push(handler);
}

export async function emitAccountingEvent(event: AccountingEvent) {
  for (const h of handlers) {
    try {
      await h(event);
    } catch (err) {
      // Don't let sync failures block the main transaction
      console.error('[accounting.sync] handler error:', err);
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Payment method → account name
// ─────────────────────────────────────────────────────────────

function paymentMethodToAccount(method: string): string {
  const m = method.toLowerCase();
  if (m.includes('каспи') || m.includes('kaspi')) return 'Каспи';
  if (m.includes('нал') || m.includes('cash') || m.includes('наличн')) return 'Касса';
  if (m.includes('перевод') || m.includes('банк') || m.includes('bank')) return 'Банк';
  if (m.includes('карт') || m.includes('card')) return 'Банк';
  return 'Касса';
}

// ─────────────────────────────────────────────────────────────
//  Register all event handlers
// ─────────────────────────────────────────────────────────────

export function registerAccountingSync() {
  onAccountingEvent(async (event) => {
    const { orgId, type, payload } = event;

    switch (type) {
      // ── Сделка выиграна ─────────────────────────────────
      case 'deal.won': {
        const { dealId, title, value, assignedName } = payload as {
          dealId: string; title: string; value: number; assignedName?: string;
        };
        if (value <= 0) break;
        await createEntry(orgId, {
          type: 'income',
          amount: value,
          category: 'Реализация',
          account: 'Дебиторка',
          sourceModule: 'deal',
          sourceId: dealId,
          sourceLabel: title as string,
          author: (assignedName as string) ?? 'system',
        });
        break;
      }

      // ── Оплата по сделке ─────────────────────────────────
      case 'deal.payment': {
        const { dealId, title, amount, method, authorName } = payload as {
          dealId: string; title: string; amount: number; method: string; authorName?: string;
        };
        await createEntry(orgId, {
          type: 'income',
          amount: amount as number,
          category: 'Реализация',
          account: paymentMethodToAccount(method as string),
          sourceModule: 'deal',
          sourceId: dealId,
          sourceLabel: title as string,
          author: (authorName as string) ?? 'system',
        });
        break;
      }

      // ── Заказ Чапан завершён ─────────────────────────────
      case 'chapan_order.completed': {
        const { orderId, orderNumber, paidAmount, clientName, authorName } = payload as {
          orderId: string; orderNumber: string; paidAmount: number; clientName: string; authorName?: string;
        };
        if ((paidAmount as number) > 0) {
          await createEntry(orgId, {
            type: 'income',
            amount: paidAmount as number,
            category: 'Реализация',
            account: 'Каспи', // default — refined by payment records
            counterparty: clientName as string,
            sourceModule: 'order',
            sourceId: orderId,
            sourceLabel: `Заказ ${orderNumber}`,
            author: (authorName as string) ?? 'system',
          });
        }
        break;
      }

      // ── Платёж по заказу Чапан ───────────────────────────
      case 'chapan_payment.added': {
        const { orderId, orderNumber, amount, method, clientName, authorName } = payload as {
          orderId: string; orderNumber: string; amount: number; method: string;
          clientName: string; authorName?: string;
        };
        await createEntry(orgId, {
          type: 'income',
          amount: amount as number,
          category: 'Реализация',
          account: paymentMethodToAccount(method as string),
          counterparty: clientName as string,
          sourceModule: 'order',
          sourceId: orderId,
          sourceLabel: `Заказ ${orderNumber}`,
          author: (authorName as string) ?? 'system',
          tags: ['payment'],
        });
        break;
      }

      // ── Поступление на склад ─────────────────────────────
      case 'warehouse.movement_in': {
        const { itemId, itemName, qty, costPrice, sourceType, sourceId, authorName } = payload as {
          itemId: string; itemName: string; qty: number; costPrice: number;
          sourceType?: string; sourceId?: string; authorName?: string;
        };
        const value = (qty as number) * (costPrice as number);
        if (value <= 0) break;
        await createEntry(orgId, {
          type: 'expense',
          amount: value,
          category: 'Материалы',
          account: 'Склад',
          sourceModule: sourceType as string ?? 'warehouse',
          sourceId: sourceId as string ?? itemId,
          sourceLabel: `Поступление: ${itemName} (${qty} ед.)`,
          author: (authorName as string) ?? 'system',
        });
        break;
      }

      // ── Списание со склада ───────────────────────────────
      case 'warehouse.write_off': {
        const { itemId, itemName, qty, costPrice, reason, authorName } = payload as {
          itemId: string; itemName: string; qty: number; costPrice: number;
          reason?: string; authorName?: string;
        };
        const value = (qty as number) * (costPrice as number);
        if (value <= 0) break;
        await createEntry(orgId, {
          type: 'write_off',
          amount: value,
          category: 'Списание',
          account: 'Склад',
          sourceModule: 'warehouse',
          sourceId: itemId,
          sourceLabel: `Списание: ${itemName} (${qty} ед.)${reason ? ` — ${reason}` : ''}`,
          author: (authorName as string) ?? 'system',
        });
        break;
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  Convenience exports for other modules to use
// ─────────────────────────────────────────────────────────────

export async function syncChapanPayment(params: {
  orgId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  method: string;
  clientName: string;
  authorName: string;
}) {
  await emitAccountingEvent({
    type: 'chapan_payment.added',
    orgId: params.orgId,
    payload: { ...params },
  });
}

export async function syncDealWon(params: {
  orgId: string;
  dealId: string;
  title: string;
  value: number;
  assignedName?: string;
}) {
  await emitAccountingEvent({
    type: 'deal.won',
    orgId: params.orgId,
    payload: { ...params },
  });
}

export async function syncWarehouseMovement(params: {
  orgId: string;
  type: 'in' | 'write_off';
  itemId: string;
  itemName: string;
  qty: number;
  costPrice: number;
  sourceType?: string;
  sourceId?: string;
  reason?: string;
  authorName?: string;
}) {
  const eventType = params.type === 'in' ? 'warehouse.movement_in' : 'warehouse.write_off';
  await emitAccountingEvent({
    type: eventType,
    orgId: params.orgId,
    payload: { ...params },
  });
}
