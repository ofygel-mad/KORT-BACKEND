import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';
import * as svc from './deals.service.js';

export async function dealsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/deals
  app.get('/', async (request) => {
    const params = paginationSchema.parse(request.query);
    return svc.list(request.orgId, params);
  });

  // GET /api/v1/deals/board
  app.get('/board/', async (request) => {
    return svc.getBoard(request.orgId);
  });

  // GET /api/v1/deals/:id/activities
  app.get('/:id/activities', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getActivities(request.orgId, id);
  });

  // GET /api/v1/deals/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/deals
  app.post('/', async (request, reply) => {
    const body = z.object({
      title: z.string().min(1),
      fullName: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      companyName: z.string().optional(),
      source: z.string().optional(),
      value: z.union([z.number(), z.string()]).nullable().optional(),
      amount: z.union([z.number(), z.string()]).nullable().optional(),
      currency: z.string().optional(),
      assignedTo: z.string().optional(),
      assignedName: z.string().optional(),
      leadId: z.string().optional(),
      customerId: z.string().optional(),
      customer_id: z.string().optional(),
      stageId: z.string().optional(),
      stage_id: z.string().optional(),
    }).parse(request.body);

    const deal = await svc.create(request.orgId, body, request.userId, request.userFullName);
    return reply.status(201).send(deal);
  });

  // PATCH /api/v1/deals/:id
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.update(request.orgId, id, request.body as Record<string, unknown>, request.userFullName);
  });

  // POST /api/v1/deals/:id/activities
  app.post('/:id/activities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      type: z.string(),
      content: z.string().optional(),
      payload: z.object({
        body: z.string().optional(),
        title: z.string().optional(),
      }).optional(),
    }).parse(request.body);

    const activity = await svc.addActivity(request.orgId, id, {
      ...body,
      author: request.userFullName,
    });
    return reply.status(201).send(activity);
  });

  // DELETE /api/v1/deals/:id
  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.remove(request.orgId, id);
  });
}
