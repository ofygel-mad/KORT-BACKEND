import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './orders.service.js';

export async function chapanOrdersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/orders
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    const orders = await svc.list(request.orgId, {
      status: query.status,
      priority: query.priority,
      paymentStatus: query.paymentStatus,
      search: query.search,
      sortBy: query.sortBy,
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
      items: z.array(z.object({
        productName: z.string(),
        fabric: z.string(),
        size: z.string(),
        quantity: z.number().int().min(1),
        unitPrice: z.number().min(0),
        notes: z.string().optional(),
        workshopNotes: z.string().optional(),
      })).min(1),
      dueDate: z.string().optional(),
      sourceRequestId: z.string().optional(),
    }).parse(request.body);

    const order = await svc.create(request.orgId, request.userId, request.userFullName, body);
    return reply.status(201).send(order);
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
      method: z.enum(['cash', 'card', 'transfer']),
      notes: z.string().optional(),
    }).parse(request.body);

    const payment = await svc.addPayment(request.orgId, id, request.userId, request.userFullName, body);
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

  // POST /api/v1/chapan/orders/:id/activities
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
