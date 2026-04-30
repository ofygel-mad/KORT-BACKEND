import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './orders.service.js';
import { generateInvoiceXlsx, generateBatchInvoiceXlsx } from './invoice.service.js';
import type { InvoiceDocumentPayload } from './invoice-document.js';
import { getWarehouseOrderState, getWarehouseOrderStates } from '../warehouse/warehouse-projections.service.js';
import { prisma } from '../../lib/prisma.js';
import { ForbiddenError } from '../../lib/errors.js';

// ── Idempotency cache for POST /chapan/orders ──────────────────────────────
// Prevents duplicate orders when a client retries due to network latency.
// Key: `${orgId}:${idempotencyKey}` — scoped per org so keys can't leak.
const idempotencyCache = new Map<string, { status: number; body: unknown; expiresAt: number }>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
let idempSweepCounter = 0;

function sweepIdempotencyCache() {
  if (++idempSweepCounter % 50 !== 0) return;
  const now = Date.now();
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt <= now) idempotencyCache.delete(key);
  }
}
// ──────────────────────────────────────────────────────────────────────────

export async function chapanOrdersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  const orderItemSchema = z.object({
    productName: z.string(),
    color: z.string().optional(),
    gender: z.string().optional(),
    length: z.string().optional(),
    size: z.string(),
    quantity: z.number().int().min(1),
    unitPrice: z.number().min(0),
    notes: z.string().optional(),
    workshopNotes: z.string().optional(),
  });

  // GET /api/v1/chapan/orders
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    const archived = query.archived === 'true' ? true : query.archived === 'false' ? false : undefined;
    const statuses = query.statuses
      ? query.statuses.split(',').map((value) => value.trim()).filter(Boolean)
      : undefined;
    const createdFrom = query.createdFrom ? new Date(query.createdFrom) : undefined;
    const createdTo = query.createdTo ? new Date(query.createdTo) : undefined;
    const orders = await svc.list(request.orgId, {
      status: query.status,
      statuses,
      priority: query.priority,
      paymentStatus: query.paymentStatus,
      search: query.search,
      sortBy: query.sortBy,
      archived,
      hasWarehouseItems: query.hasWarehouseItems === 'true',
      createdFrom,
      createdTo,
      managerId: query.managerId || undefined,
    });
    return { count: orders.length, results: orders };
  });

  app.get('/warehouse-states', async (request) => {
    const query = z.object({
      ids: z.string().min(1),
    }).parse(request.query);

    const ids = query.ids
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    const results = await getWarehouseOrderStates(request.orgId, ids);
    return { count: results.length, results };
  });

  // GET /api/v1/chapan/orders/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  app.get('/:id/warehouse-state', async (request) => {
    const { id } = request.params as { id: string };
    return getWarehouseOrderState(request.orgId, id);
  });

  // POST /api/v1/chapan/orders
  app.post('/', async (request, reply) => {
    const body = z.object({
      clientId: z.string().optional(),
      clientName: z.string().min(1),
      clientPhone: z.string().optional().default(''),
      clientPhoneForeign: z.string().optional(),
      priority: z.enum(['normal', 'urgent', 'vip']).default('normal'),
      urgency: z.enum(['normal', 'urgent']).optional(),
      isDemandingClient: z.boolean().optional(),
      items: z.array(orderItemSchema).min(1),
      dueDate: z.string().optional(),
      prepayment: z.number().min(0).optional(),
      paymentMethod: z.string().trim().min(1).optional(),
      paymentBreakdown: z.record(z.string(), z.number().min(0)).optional(),
      streetAddress: z.string().optional(),
      city: z.string().trim().optional(),
      postalCode: z.string().trim().optional(),
      deliveryType: z.string().trim().optional(),
      source: z.string().trim().optional(),
      expectedPaymentMethod: z.string().trim().optional(),
      orderDate: z.string().optional(),
      orderDiscount: z.number().min(0).optional(),
      deliveryFee: z.number().min(0).optional(),
      bankCommissionPercent: z.number().min(0).max(100).optional(),
      bankCommissionAmount: z.number().min(0).optional(),
      managerNote: z.string().optional(),
      sourceRequestId: z.string().optional(),
    }).refine(
      (d) => !!(d.clientPhone?.trim()) || !!(d.clientPhoneForeign?.trim()),
      { message: 'Укажите казахстанский или иностранный номер телефона', path: ['clientPhone'] },
    ).parse(request.body);

    // Idempotency check — return the original response if the client retries the same request
    const rawIdemKey = request.headers['idempotency-key'];
    const idemKey = typeof rawIdemKey === 'string' ? rawIdemKey.slice(0, 256) : undefined;
    if (idemKey) {
      const cacheKey = `${request.orgId}:${idemKey}`;
      const cached = idempotencyCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return reply.status(cached.status).send(cached.body);
      }
    }

    const order = await svc.create(request.orgId, request.userId, request.userFullName, body);

    if (idemKey) {
      const cacheKey = `${request.orgId}:${idemKey}`;
      idempotencyCache.set(cacheKey, { status: 201, body: order, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
      sweepIdempotencyCache();
    }

    return reply.status(201).send(order);
  });

  // PATCH /api/v1/chapan/orders/:id
  app.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      clientName: z.string().min(1).optional(),
      clientPhone: z.string().optional(),
      clientPhoneForeign: z.string().optional(),
      dueDate: z.string().nullable().optional(),
      priority: z.enum(['normal', 'urgent', 'vip']).optional(),
      urgency: z.enum(['normal', 'urgent']).optional(),
      isDemandingClient: z.boolean().optional(),
      // Address / delivery fields
      city: z.string().trim().optional(),
      streetAddress: z.string().optional(),
      postalCode: z.string().trim().optional(),
      deliveryType: z.string().trim().optional(),
      source: z.string().trim().optional(),
      orderDate: z.string().optional(),
      // Financial fields
      orderDiscount: z.number().min(0).optional(),
      deliveryFee: z.number().min(0).optional(),
      bankCommissionPercent: z.number().min(0).max(100).optional(),
      bankCommissionAmount: z.number().min(0).optional(),
      // Payment fields
      prepayment: z.number().min(0).optional(),
      paymentMethod: z.string().optional(),
      expectedPaymentMethod: z.string().optional(),
      paymentBreakdown: z.record(z.string(), z.number().min(0)).optional(),
      items: z.array(orderItemSchema).optional(),
    }).parse(request.body);

    const updated = await svc.update(request.orgId, id, request.userId, request.userFullName, body);
    return reply.send(updated);
  });

  // POST /api/v1/chapan/orders/:id/restore
  app.post('/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.restore(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/archive
  app.post('/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.archive(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/close
  app.post('/:id/close', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.close(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/fulfill-from-stock
  app.post('/:id/fulfill-from-stock', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.fulfillFromStock(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/route-items
  app.post('/:id/route-items', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      items: z.array(z.object({
        itemId: z.string().min(1),
        fulfillmentMode: z.enum(['warehouse', 'production']),
      })).min(1),
    }).parse(request.body);

    const order = await svc.routeItems(request.orgId, id, request.userId, request.userFullName, body.items);
    return reply.send(order);
  });

  // POST /api/v1/chapan/orders/:id/confirm
  app.post('/:id/confirm', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.confirm(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // PATCH /api/v1/chapan/orders/:id/status
  app.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, cancelReason } = z.object({
      status: z.string(),
      cancelReason: z.string().optional(),
    }).parse(request.body);

    await svc.updateStatus(request.orgId, id, status, request.userId, request.userFullName, cancelReason);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/payments
  app.post('/:id/payments', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      amount: z.number().min(0),
      method: z.string().trim().min(1),
      note: z.string().optional(),
      notes: z.string().optional(),
    }).parse(request.body);

    const payment = await svc.addPayment(request.orgId, id, request.userId, request.userFullName, {
      amount: body.amount,
      method: body.method,
      notes: body.notes ?? body.note,
    });
    return reply.status(201).send(payment);
  });

  // POST /api/v1/chapan/orders/:id/transfer
  app.post('/:id/transfer', async (request, reply) => {
    const { id } = request.params as { id: string };
    const transfer = await svc.initiateTransfer(request.orgId, id);
    return reply.status(201).send(transfer);
  });

  // POST /api/v1/chapan/orders/:id/transfer/confirm
  app.post('/:id/transfer/confirm', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { by } = z.object({ by: z.enum(['manager', 'client']) }).parse(request.body);
    const transfer = await svc.confirmTransfer(request.orgId, id, by, request.userId, request.userFullName);
    return reply.send(transfer);
  });

  // GET /api/v1/chapan/orders/:id/invoice?style=branded|default
  app.get('/:id/invoice', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { style } = z.object({
      style: z.enum(['default', 'branded']).default('branded'),
    }).parse(request.query);

    const buffer = await generateInvoiceXlsx(request.orgId, id, style);
    const filename = `nakladnaya-${id.slice(0, 8)}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });

  // POST /api/v1/chapan/orders/batch-invoice
  app.post('/batch-invoice', async (request, reply) => {
    const body = z.object({
      orderIds: z.array(z.string()).min(1),
      style: z.enum(['default', 'branded']).default('branded'),
      documentPayload: z.unknown().optional(),
    }).parse(request.body);

    const buffer = await generateBatchInvoiceXlsx(
      request.orgId,
      body.orderIds,
      body.style,
      undefined,
      body.documentPayload as InvoiceDocumentPayload | undefined,
    );
    const filename = `nakladnaya-batch-${Date.now()}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });

  // POST /api/v1/chapan/orders/:id/activities
  // POST /api/v1/chapan/orders/:id/ship — Warehouse ships to client
  app.post('/:id/ship', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      courierType:      z.string().trim().optional(),
      recipientName:    z.string().trim().optional(),
      recipientAddress: z.string().trim().optional(),
      shippingNote:     z.string().trim().optional(),
    }).parse(request.body ?? {});

    await svc.shipOrder(request.orgId, id, request.userId, request.userFullName, body);
    return reply.send({ ok: true });
  });

  app.post('/:id/activities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      type: z.string(),
      content: z.string(),
    }).parse(request.body);

    const activity = await svc.addActivity(request.orgId, id, request.userId, request.userFullName, body);
    return reply.status(201).send(activity);
  });

  // PATCH /api/v1/chapan/orders/:id/requires-invoice — toggle invoice requirement
  app.patch('/:id/requires-invoice', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ requiresInvoice: z.boolean() }).parse(request.body);
    return svc.setRequiresInvoice(request.orgId, id, body.requiresInvoice);
  });

  // POST /api/v1/chapan/orders/:id/return-to-ready — warehouse returns order to "Готово"
  app.post('/:id/return-to-ready', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ reason: z.string().min(1) }).parse(request.body);
    return svc.returnToReady(request.orgId, id, request.userId, request.userFullName, body.reason);
  });

  // POST /api/v1/chapan/orders/:id/items/:itemId/route — route single item immediately
  app.post('/:id/items/:itemId/route', async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = z.object({
      fulfillmentMode: z.enum(['warehouse', 'production']),
    }).parse(request.body);

    await svc.routeSingleItem(request.orgId, id, itemId, body.fulfillmentMode, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/:id/change-request — manager submits item change request for in_production order
  app.post('/:id/change-request', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      items: z.array(z.object({
        productName: z.string().min(1),
        size: z.string().min(1),
        quantity: z.number().int().min(1),
        unitPrice: z.number().min(0),
        notes: z.string().optional(),
        workshopNotes: z.string().optional(),
      })).min(1),
      managerNote: z.string().optional(),
    }).parse(request.body);

    const result = await svc.requestItemChange(
      request.orgId, id, request.userId, request.userFullName, body.items, body.managerNote,
    );
    return reply.status(201).send(result);
  });

  // GET /api/v1/chapan/orders/change-requests — list pending change requests (for production page)
  app.get('/change-requests', async (request) => {
    return svc.listPendingChangeRequests(request.orgId);
  });

  // POST /api/v1/chapan/orders/change-requests/:crId/approve — seamstress approves
  app.post('/change-requests/:crId/approve', async (request, reply) => {
    const { crId } = request.params as { crId: string };
    await svc.approveChangeRequest(request.orgId, crId, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/orders/change-requests/:crId/reject — seamstress rejects with reason
  app.post('/change-requests/:crId/reject', async (request, reply) => {
    const { crId } = request.params as { crId: string };
    const body = z.object({ rejectReason: z.string().min(1) }).parse(request.body);
    await svc.rejectChangeRequest(request.orgId, crId, request.userId, request.userFullName, body.rejectReason);
    return reply.send({ ok: true });
  });
  // ── Trash (soft-delete) routes ────────────────────────────────────────────

  // POST /api/v1/chapan/orders/:id/trash  — manager sends to trash
  app.post('/:id/trash', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('manager', 'admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.trashOrder(request.orgId, id, request.userId, request.userFullName);
    return reply.send(result);
  });

  // POST /api/v1/chapan/orders/:id/restore-from-trash  — owner/full_access restores
  app.post('/:id/restore-from-trash', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.restoreFromTrash(request.orgId, id, request.userId, request.userFullName);
    return reply.send(result);
  });

  // DELETE /api/v1/chapan/orders/:id  — permanent delete, owner/full_access only
  app.delete('/:id', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.permanentDelete(request.orgId, id);
    return reply.send(result);
  });

  // GET /api/v1/chapan/orders/trash  — list trashed orders, owner/full_access only
  app.get('/trash', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request) => {
    return svc.listTrashed(request.orgId);
  });

  // GET /api/v1/chapan/orders/managers — list all active org members (for reassign dropdown)
  app.get('/managers', async (request) => {
    return svc.listOrgManagers(request.orgId);
  });

  // PATCH /api/v1/chapan/orders/:id/manager — reassign order to another manager
  // Access: owner | admin | employee with chapan_full_access | full_access
  app.patch('/:id/manager', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { managerId } = z.object({
      managerId: z.string().min(1),
    }).parse(request.body);

    // Permission check: role-based OR permission-based
    const membership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: request.userId, orgId: request.orgId } },
    });

    const role = membership?.role ?? '';
    const perms: string[] = membership?.employeePermissions ?? [];
    const canReassign =
      role === 'owner' ||
      role === 'admin' ||
      perms.includes('full_access') ||
      perms.includes('chapan_full_access');

    if (!canReassign) {
      throw new ForbiddenError('Недостаточно прав для переназначения менеджера');
    }

    // Resolve new manager's name from org membership
    const newMembership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: managerId, orgId: request.orgId } },
      include: { user: { select: { fullName: true } } },
    });
    if (!newMembership || newMembership.status !== 'active' || newMembership.employeeAccountStatus === 'dismissed') {
      throw new ForbiddenError('Выбранный менеджер недоступен в данной организации');
    }

    const newManagerName = newMembership.user.fullName;
    const order = await svc.reassignManager(
      request.orgId,
      id,
      managerId,
      newManagerName,
      request.userId,
      request.userFullName,
    );
    return reply.send(order);
  });

}
