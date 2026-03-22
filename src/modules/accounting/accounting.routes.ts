/**
 * accounting.routes.ts
 * All accounting REST endpoints — prefixed at /api/v1/accounting
 */

import type { FastifyPluginAsync } from 'fastify';
import * as svc from './accounting.service.js';

export const accountingRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);

  // ── Summary ─────────────────────────────────────────────────
  app.get<{ Querystring: { period?: string } }>('/summary', async (req) => {
    return svc.getSummary(req.orgId!, req.query.period);
  });

  // ── Entries list ────────────────────────────────────────────
  app.get<{
    Querystring: {
      period?: string; from?: string; to?: string; type?: string;
      sourceModule?: string; account?: string; search?: string;
      isReconciled?: string; page?: string; limit?: string;
    };
  }>('/entries', async (req) => {
    const q = req.query;
    return svc.listEntries(req.orgId!, {
      period: q.period,
      from: q.from,
      to: q.to,
      type: q.type,
      sourceModule: q.sourceModule,
      account: q.account,
      search: q.search,
      isReconciled: q.isReconciled === 'true' ? true : q.isReconciled === 'false' ? false : undefined,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 50,
    });
  });

  // ── Create manual entry ─────────────────────────────────────
  app.post<{
    Body: {
      type: string; amount: number; currency?: string; category: string;
      account: string; counterparty?: string; sourceModule?: string;
      sourceId?: string; sourceLabel?: string; tags?: string[]; notes?: string;
    };
  }>('/entries', async (req, reply) => {
    const entry = await svc.createEntry(req.orgId!, {
      ...req.body,
      type: req.body.type as any,
      author: req.userFullName,
    });
    return reply.status(201).send(entry);
  });

  // ── Reconcile ───────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/entries/:id/reconcile', async (req) => {
    return svc.reconcileEntry(req.orgId!, req.params.id, req.userFullName);
  });

  // ── P&L ─────────────────────────────────────────────────────
  app.get<{ Querystring: { period?: string } }>('/pnl', async (req) => {
    const period = req.query.period ?? new Date().toISOString().slice(0, 7);
    return svc.getPnL(req.orgId!, period);
  });

  // ── Cash Flow ───────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>('/cashflow', async (req) => {
    const to = req.query.to ?? new Date().toISOString().slice(0, 10);
    const from = req.query.from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return svc.getCashFlow(req.orgId!, from, to);
  });

  // ── Inventory value ─────────────────────────────────────────
  app.get('/inventory-value', async (req) => {
    return svc.getInventoryValue(req.orgId!);
  });

  // ── Debts ───────────────────────────────────────────────────
  app.get('/debts', async (req) => {
    return svc.getDebts(req.orgId!);
  });

  // ── Gaps ────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/gaps', async (req) => {
    // Run detection first, then return
    await svc.detectAndSaveGaps(req.orgId!);
    return svc.listGaps(req.orgId!, req.query.status ?? 'open');
  });

  app.patch<{
    Params: { id: string };
    Body: { action: 'resolve' | 'ignore' };
  }>('/gaps/:id', async (req) => {
    return svc.resolveGap(req.orgId!, req.params.id, req.body.action, req.userFullName);
  });

  // ── Chain integrity ─────────────────────────────────────────
  app.get('/integrity', async (req) => {
    return svc.verifyIntegrity(req.orgId!);
  });

  // ── Export data ─────────────────────────────────────────────
  app.get<{
    Querystring: { period?: string; type?: string; from?: string; to?: string; format?: string };
  }>('/export', async (req, reply) => {
    const rows = await svc.getExportData(req.orgId!, req.query);

    // Return as JSON for now; XLSX generation is a client-side responsibility
    // or can be added with exceljs later
    return reply.send({
      rows,
      exportedAt: new Date().toISOString(),
      count: rows.length,
    });
  });
};
