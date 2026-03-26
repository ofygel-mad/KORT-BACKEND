import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './orders.service.js';
import { generateInvoiceXlsx, generateBatchInvoiceXlsx } from './invoice.service.js';

export async function chapanOrdersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  const orderItemSchema = z.object({
    productName: z.string(),
    fabric: z.string().optional(),
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
    const orders = await svc.list(request.orgId, {
      status: query.status,
      statuses,
      priority: query.priority,
      paymentStatus: query.paymentStatus,
      search: query.search,
      sortBy: query.sortBy,
      archived,
    });
    return { count: orders.length, results: orders };
  });

  // GET /api/v1/chapan/orders/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/chapan/orders
  app.post('/', async (request, reply) => {
    const body = z.object({
      clientId: z.string().optional(),
      clientName: z.string().min(1),
      clientPhone: z.string().min(1),
      priority: z.enum(['normal', 'urgent', 'vip']).default('normal'),
      items: z.array(orderItemSchema).min(1),
      dueDate: z.string().optional(),
      prepayment: z.number().min(0).optional(),
      paymentMethod: z.string().trim().min(1).optional(),
      mixedBreakdown: z.object({
        mixedCash: z.number().min(0),
        mixedKaspiQr: z.number().min(0),
        mixedKaspiTerminal: z.number().min(0),
        mixedTransfer: z.number().min(0),
      }).optional(),
      streetAddress: z.string().optional(),
      managerNote: z.string().optional(),
      sourceRequestId: z.string().optional(),
    }).parse(request.body);

    const order = await svc.create(request.orgId, request.userId, request.userFullName, body);
    return reply.status(201).send(order);
  });

  // PATCH /api/v1/chapan/orders/:id
  app.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      clientName: z.string().min(1).optional(),
      clientPhone: z.string().min(1).optional(),
      dueDate: z.string().nullable().optional(),
      priority: z.enum(['normal', 'urgent', 'vip']).optional(),
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
    }).parse(request.body);

    const buffer = await generateBatchInvoiceXlsx(request.orgId, body.orderIds, body.style);
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
    await svc.shipOrder(request.orgId, id, request.userId, request.userFullName);
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
}
