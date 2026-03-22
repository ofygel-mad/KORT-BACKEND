/**
 * accounting.service.ts
 *
 * Core accounting business logic:
 *  - Immutable ledger entries (hash chain)
 *  - Aggregates: summary, P&L, cash flow, inventory value, debts
 *  - Gap detection between modules
 *  - Export (data, not file — file generation in routes)
 */

import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { computeEntryHash, verifyChain } from './accounting.hash.js';

// ─────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────

export interface CreateEntryDto {
  type: 'income' | 'expense' | 'transfer' | 'adjustment' | 'write_off' | 'return';
  amount: number;
  currency?: string;
  category: string;
  account: string;
  counterparty?: string;
  sourceModule?: string;
  sourceId?: string;
  sourceLabel?: string;
  author: string;
  tags?: string[];
  notes?: string;
}

export interface EntryFilterDto {
  period?: string;       // YYYY-MM
  from?: string;         // ISO date
  to?: string;           // ISO date
  type?: string;
  sourceModule?: string;
  account?: string;
  search?: string;
  isReconciled?: boolean;
  page?: number;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function periodFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Get or create the next sequence number for an org */
async function nextSeq(orgId: string): Promise<{ seq: number; lastHash: string | null }> {
  const last = await prisma.accountingEntry.findFirst({
    where: { orgId },
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  return { seq: (last?.seq ?? 0) + 1, lastHash: last?.hash ?? null };
}

// ─────────────────────────────────────────────────────────────
//  Create Entry
// ─────────────────────────────────────────────────────────────

export async function createEntry(orgId: string, dto: CreateEntryDto) {
  const { seq, lastHash } = await nextSeq(orgId);
  const period = periodFromDate(new Date());

  const hash = computeEntryHash({
    seq,
    amount: dto.amount,
    type: dto.type,
    sourceId: dto.sourceId ?? null,
    prevHash: lastHash,
  });

  return prisma.accountingEntry.create({
    data: {
      orgId,
      seq,
      type: dto.type,
      amount: dto.amount,
      currency: dto.currency ?? 'KZT',
      category: dto.category,
      account: dto.account,
      counterparty: dto.counterparty,
      sourceModule: dto.sourceModule,
      sourceId: dto.sourceId,
      sourceLabel: dto.sourceLabel,
      period,
      author: dto.author,
      prevHash: lastHash,
      hash,
      tags: dto.tags ?? [],
      notes: dto.notes,
    },
  });
}

// ─────────────────────────────────────────────────────────────
//  List Entries
// ─────────────────────────────────────────────────────────────

export async function listEntries(orgId: string, filter: EntryFilterDto) {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(200, filter.limit ?? 50);
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { orgId };

  if (filter.period) where.period = filter.period;
  if (filter.type) where.type = filter.type;
  if (filter.sourceModule) where.sourceModule = filter.sourceModule;
  if (filter.account) where.account = filter.account;
  if (filter.isReconciled !== undefined) where.isReconciled = filter.isReconciled;

  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: new Date(filter.from) } : {}),
      ...(filter.to ? { lte: new Date(filter.to) } : {}),
    };
  }

  if (filter.search) {
    where.OR = [
      { counterparty: { contains: filter.search, mode: 'insensitive' } },
      { sourceLabel: { contains: filter.search, mode: 'insensitive' } },
      { category: { contains: filter.search, mode: 'insensitive' } },
      { notes: { contains: filter.search, mode: 'insensitive' } },
    ];
  }

  const [total, results] = await Promise.all([
    prisma.accountingEntry.count({ where }),
    prisma.accountingEntry.findMany({
      where,
      orderBy: { seq: 'desc' },
      skip,
      take: limit,
    }),
  ]);

  return { results, total, page, limit };
}

// ─────────────────────────────────────────────────────────────
//  Summary (KPI)
// ─────────────────────────────────────────────────────────────

export async function getSummary(orgId: string, period?: string) {
  const currentPeriod = period ?? periodFromDate(new Date());
  // Previous period
  const [yearRaw, monthRaw] = currentPeriod.split('-').map(Number);
  const today = new Date();
  const year = typeof yearRaw === 'number' && Number.isFinite(yearRaw)
    ? yearRaw
    : today.getFullYear();
  const month = typeof monthRaw === 'number' && Number.isFinite(monthRaw)
    ? monthRaw
    : today.getMonth() + 1;
  const prevDate = new Date(year, month - 2, 1);
  const prevPeriod = periodFromDate(prevDate);

  async function periodAgg(p: string) {
    const entries = await prisma.accountingEntry.findMany({
      where: { orgId, period: p },
      select: { type: true, amount: true },
    });
    const income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
    const expense = entries
      .filter((e) => ['expense', 'write_off'].includes(e.type))
      .reduce((s, e) => s + e.amount, 0);
    return { income, expense, profit: income - expense };
  }

  const [current, previous] = await Promise.all([
    periodAgg(currentPeriod),
    periodAgg(prevPeriod),
  ]);

  // Debts: chapan orders not fully paid
  const debtOrders = await prisma.chapanOrder.findMany({
    where: {
      orgId,
      status: { notIn: ['cancelled'] },
      totalAmount: { gt: 0 },
    },
    select: { totalAmount: true, paidAmount: true },
  });
  const totalDebt = debtOrders.reduce((s, o) => s + Math.max(0, o.totalAmount - o.paidAmount), 0);

  // Open gaps
  const gapCount = await prisma.accountingGap.count({ where: { orgId, status: 'open' } });

  // Last entry
  const lastEntry = await prisma.accountingEntry.findFirst({
    where: { orgId },
    orderBy: { seq: 'desc' },
    select: { createdAt: true, amount: true, type: true },
  });

  function pct(a: number, b: number) {
    if (b === 0) return null;
    return Math.round(((a - b) / b) * 100);
  }

  return {
    period: currentPeriod,
    income: current.income,
    expense: current.expense,
    profit: current.profit,
    incomePct: pct(current.income, previous.income),
    expensePct: pct(current.expense, previous.expense),
    profitPct: pct(current.profit, previous.profit),
    totalDebt,
    openGaps: gapCount,
    lastEntry,
  };
}

// ─────────────────────────────────────────────────────────────
//  P&L by category
// ─────────────────────────────────────────────────────────────

export async function getPnL(orgId: string, period: string) {
  const entries = await prisma.accountingEntry.findMany({
    where: { orgId, period },
    select: { type: true, category: true, amount: true },
  });

  const incomeMap: Record<string, number> = {};
  const expenseMap: Record<string, number> = {};
  let totalIncome = 0;
  let totalExpense = 0;

  for (const e of entries) {
    if (e.type === 'income' || e.type === 'return') {
      incomeMap[e.category] = (incomeMap[e.category] ?? 0) + e.amount;
      totalIncome += e.amount;
    } else if (e.type === 'expense' || e.type === 'write_off') {
      expenseMap[e.category] = (expenseMap[e.category] ?? 0) + e.amount;
      totalExpense += e.amount;
    }
  }

  const toRows = (map: Record<string, number>, total: number) =>
    Object.entries(map)
      .sort((a, b) => b[1] - a[1])
      .map(([category, amount]) => ({
        category,
        amount,
        pct: total > 0 ? Math.round((amount / total) * 100) : 0,
      }));

  return {
    period,
    income: { total: totalIncome, rows: toRows(incomeMap, totalIncome) },
    expense: { total: totalExpense, rows: toRows(expenseMap, totalExpense) },
    grossProfit: totalIncome - totalExpense,
    grossMargin: totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0,
  };
}

// ─────────────────────────────────────────────────────────────
//  Cash Flow (by day)
// ─────────────────────────────────────────────────────────────

export async function getCashFlow(orgId: string, from: string, to: string) {
  const entries = await prisma.accountingEntry.findMany({
    where: {
      orgId,
      createdAt: { gte: new Date(from), lte: new Date(to) },
    },
    select: { type: true, amount: true, createdAt: true, account: true },
    orderBy: { createdAt: 'asc' },
  });

  const byDay: Record<string, { income: number; expense: number }> = {};
  for (const e of entries) {
    const day = e.createdAt.toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { income: 0, expense: 0 };
    if (e.type === 'income') byDay[day].income += e.amount;
    else if (e.type === 'expense' || e.type === 'write_off') byDay[day].expense += e.amount;
  }

  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v, net: v.income - v.expense }));
}

// ─────────────────────────────────────────────────────────────
//  Inventory Value
// ─────────────────────────────────────────────────────────────

export async function getInventoryValue(orgId: string) {
  const items = await prisma.warehouseItem.findMany({
    where: { orgId },
    include: { category: { select: { name: true, color: true } } },
  });

  const byCategory: Record<string, { name: string; color: string; itemCount: number; totalQty: number; totalValue: number }> = {};

  for (const item of items) {
    const catName = item.category?.name ?? 'Без категории';
    const catColor = item.category?.color ?? '#888888';
    if (!byCategory[catName]) {
      byCategory[catName] = { name: catName, color: catColor, itemCount: 0, totalQty: 0, totalValue: 0 };
    }
    byCategory[catName].itemCount += 1;
    byCategory[catName].totalQty += item.qty;
    byCategory[catName].totalValue += item.qty * (item.costPrice ?? 0);
  }

  const rows = Object.values(byCategory).sort((a, b) => b.totalValue - a.totalValue);
  const grandTotal = rows.reduce((s, r) => s + r.totalValue, 0);

  return {
    rows: rows.map((r) => ({
      ...r,
      pct: grandTotal > 0 ? Math.round((r.totalValue / grandTotal) * 100) : 0,
    })),
    grandTotal,
    itemCount: items.length,
  };
}

// ─────────────────────────────────────────────────────────────
//  Debts (receivable + payable)
// ─────────────────────────────────────────────────────────────

export async function getDebts(orgId: string) {
  // Receivable: chapan orders not fully paid
  const orders = await prisma.chapanOrder.findMany({
    where: { orgId, status: { notIn: ['cancelled'] } },
    select: {
      id: true, orderNumber: true, clientName: true,
      totalAmount: true, paidAmount: true, dueDate: true, createdAt: true,
    },
  });

  const receivable = orders
    .map((o) => ({
      id: o.id,
      label: `Заказ ${o.orderNumber}`,
      counterparty: o.clientName,
      amount: Math.max(0, o.totalAmount - o.paidAmount),
      dueDate: o.dueDate,
      daysSince: Math.floor((Date.now() - o.createdAt.getTime()) / 86400000),
      sourceModule: 'order',
      sourceId: o.id,
    }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.daysSince - a.daysSince);

  // Payable: warehouse items with negative movements (manual entries with expense + payable account)
  const payableEntries = await prisma.accountingEntry.findMany({
    where: { orgId, type: 'expense', account: 'Кредиторка' },
    select: { id: true, amount: true, counterparty: true, sourceLabel: true, createdAt: true, sourceId: true },
  });

  const payable = payableEntries.map((e) => ({
    id: e.id,
    label: e.sourceLabel ?? 'Расход',
    counterparty: e.counterparty ?? '—',
    amount: e.amount,
    dueDate: null,
    daysSince: Math.floor((Date.now() - e.createdAt.getTime()) / 86400000),
    sourceModule: 'accounting',
    sourceId: e.sourceId,
  }));

  return {
    receivable,
    payable,
    totalReceivable: receivable.reduce((s, r) => s + r.amount, 0),
    totalPayable: payable.reduce((s, r) => s + r.amount, 0),
  };
}

// ─────────────────────────────────────────────────────────────
//  Gap Detector
// ─────────────────────────────────────────────────────────────

export async function detectAndSaveGaps(orgId: string) {
  const newGaps: Array<{
    orgId: string;
    type: string;
    severity: string;
    description: string;
    sourceModule: string;
    sourceId: string;
  }> = [];

  // GAP 1: Completed orders without accounting entry
  const completedOrders = await prisma.chapanOrder.findMany({
    where: { orgId, status: 'completed' },
    select: { id: true, orderNumber: true, totalAmount: true },
  });

  for (const order of completedOrders) {
    const hasEntry = await prisma.accountingEntry.findFirst({
      where: { orgId, sourceModule: 'order', sourceId: order.id, type: 'income' },
    });
    if (!hasEntry) {
      newGaps.push({
        orgId,
        type: 'unposted',
        severity: 'error',
        description: `Заказ ${order.orderNumber} завершён, но проводка о доходе не создана (сумма ₸${order.totalAmount.toLocaleString()})`,
        sourceModule: 'order',
        sourceId: order.id,
      });
    }
  }

  // GAP 2: Won deals without accounting entry
  const wonDeals = await prisma.deal.findMany({
    where: { orgId, stage: 'won' },
    select: { id: true, title: true, value: true },
  });

  for (const deal of wonDeals) {
    if (deal.value <= 0) continue;
    const hasEntry = await prisma.accountingEntry.findFirst({
      where: { orgId, sourceModule: 'deal', sourceId: deal.id },
    });
    if (!hasEntry) {
      newGaps.push({
        orgId,
        type: 'unposted',
        severity: 'warning',
        description: `Сделка «${deal.title}» выиграна (₸${deal.value.toLocaleString()}), но проводка отсутствует`,
        sourceModule: 'deal',
        sourceId: deal.id,
      });
    }
  }

  // GAP 3: Warehouse items without cost price (can't calculate COGS)
  const noCostItems = await prisma.warehouseItem.findMany({
    where: { orgId, costPrice: null, qty: { gt: 0 } },
    select: { id: true, name: true, qty: true, unit: true },
    take: 20,
  });

  for (const item of noCostItems) {
    newGaps.push({
      orgId,
      type: 'cost_missing',
      severity: 'info',
      description: `Товар «${item.name}» (${item.qty} ${item.unit}) не имеет себестоимости — COGS не может быть рассчитана`,
      sourceModule: 'warehouse',
      sourceId: item.id,
    });
  }

  // Upsert gaps (ignore duplicates that already exist)
  let created = 0;
  for (const gap of newGaps) {
    try {
      await prisma.accountingGap.upsert({
        where: {
          orgId_sourceModule_sourceId_type: {
            orgId: gap.orgId,
            sourceModule: gap.sourceModule,
            sourceId: gap.sourceId,
            type: gap.type,
          },
        },
        update: { description: gap.description },
        create: gap,
      });
      created++;
    } catch {
      // silently ignore unique constraint violations
    }
  }

  return { detected: newGaps.length, saved: created };
}

export async function listGaps(orgId: string, status = 'open') {
  return prisma.accountingGap.findMany({
    where: { orgId, status },
    orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function resolveGap(orgId: string, gapId: string, action: 'resolve' | 'ignore', authorName: string) {
  const gap = await prisma.accountingGap.findFirst({ where: { id: gapId, orgId } });
  if (!gap) throw new AppError(404, 'Gap not found');

  return prisma.accountingGap.update({
    where: { id: gapId },
    data: {
      status: action === 'resolve' ? 'resolved' : 'ignored',
      resolvedAt: new Date(),
      resolvedBy: authorName,
    },
  });
}

// ─────────────────────────────────────────────────────────────
//  Reconcile
// ─────────────────────────────────────────────────────────────

export async function reconcileEntry(orgId: string, entryId: string, authorName: string) {
  const entry = await prisma.accountingEntry.findFirst({ where: { id: entryId, orgId } });
  if (!entry) throw new AppError(404, 'Entry not found');

  return prisma.accountingEntry.update({
    where: { id: entryId },
    data: { isReconciled: true, reconciledAt: new Date(), reconciledBy: authorName },
  });
}

// ─────────────────────────────────────────────────────────────
//  Chain Integrity
// ─────────────────────────────────────────────────────────────

export async function verifyIntegrity(orgId: string) {
  const entries = await prisma.accountingEntry.findMany({
    where: { orgId },
    orderBy: { seq: 'asc' },
    select: { seq: true, amount: true, type: true, sourceId: true, prevHash: true, hash: true },
  });

  return verifyChain(entries);
}

// ─────────────────────────────────────────────────────────────
//  Export data (raw rows for XLSX generation)
// ─────────────────────────────────────────────────────────────

export async function getExportData(orgId: string, filter: EntryFilterDto) {
  const { results } = await listEntries(orgId, { ...filter, limit: 5000, page: 1 });
  return results;
}
