import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './requests.service.js';

export async function chapanRequestsRoutes(app: FastifyInstance) {
  // ── Public endpoint (no auth) ─────────────────────────
  // POST /api/v1/chapan/requests/public/:orgId
  app.post('/public/:orgId', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };

    const body = z.object({
      customerName: z.string().min(1),
      phone: z.string().min(1),
      messengers: z.array(z.string()).optional(),
      city: z.string().optional(),
      deliveryMethod: z.string().optional(),
      leadSource: z.string().optional(),
      preferredContact: z.enum(['phone', 'whatsapp', 'telegram']),
      desiredDate: z.string().optional(),
      notes: z.string().optional(),
      items: z.array(z.object({
        productName: z.string().min(1),
        size: z.string().optional(),
        quantity: z.number().int().min(1),
        notes: z.string().optional(),
      })).min(1),
    }).parse(request.body);

    const result = await svc.submit(orgId, { ...body, source: 'public_form' });
    return reply.status(201).send(result);
  });

  // GET /api/v1/chapan/requests/public/:orgId/profile
  app.get('/public/:orgId/profile', async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const profile = await svc.getPublicProfile(orgId);
    if (!profile) return reply.status(404).send({ error: 'NOT_FOUND', message: 'Public intake is disabled' });
    return reply.send(profile);
  });

  // ── Authenticated endpoints ───────────────────────────
  // GET /api/v1/chapan/requests
  app.get('/', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    const { status } = request.query as { status?: string };
    const results = await svc.list(request.orgId, status);
    return { count: results.length, results };
  });

  // POST /api/v1/chapan/requests (manager submitting internally)
  app.post('/', { preHandler: [app.authenticate, app.resolveOrg] }, async (request, reply) => {
    const body = z.object({
      customerName: z.string().min(1),
      phone: z.string().min(1),
      messengers: z.array(z.string()).optional(),
      city: z.string().optional(),
      deliveryMethod: z.string().optional(),
      leadSource: z.string().optional(),
      preferredContact: z.enum(['phone', 'whatsapp', 'telegram']),
      desiredDate: z.string().optional(),
      notes: z.string().optional(),
      source: z.string().optional(),
      items: z.array(z.object({
        productName: z.string().min(1),
        size: z.string().optional(),
        quantity: z.number().int().min(1),
        notes: z.string().optional(),
      })).min(1),
    }).parse(request.body);

    const result = await svc.submit(request.orgId, { ...body, source: body.source ?? 'manager' });
    return reply.status(201).send(result);
  });

  // PATCH /api/v1/chapan/requests/:id/status
  app.patch('/:id/status', { preHandler: [app.authenticate, app.resolveOrg] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, createdOrderId } = z.object({
      status: z.enum(['new', 'reviewed', 'converted', 'archived']),
      createdOrderId: z.string().optional(),
    }).parse(request.body);

    await svc.updateStatus(request.orgId, id, status, createdOrderId);
    return reply.send({ ok: true });
  });
}
