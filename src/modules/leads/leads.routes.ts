import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';
import * as svc from './leads.service.js';

export async function leadsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/leads
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    const params = {
      ...paginationSchema.parse(query),
      pipeline: query.pipeline,
      stage: query.stage,
    };
    return svc.list(request.orgId, params);
  });

  // GET /api/v1/leads/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/leads
  app.post('/', async (request, reply) => {
    const body = z.object({
      fullName: z.string().min(1),
      phone: z.string().min(1),
      source: z.string().min(1),
      pipeline: z.string().optional(),
      assignedTo: z.string().optional(),
      assignedName: z.string().optional(),
      budget: z.number().optional(),
      comment: z.string().optional(),
    }).parse(request.body);

    const lead = await svc.create(request.orgId, body);
    return reply.status(201).send(lead);
  });

  // PATCH /api/v1/leads/:id
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.update(request.orgId, id, request.body as Record<string, unknown>, request.userFullName);
  });

  // POST /api/v1/leads/:id/history
  app.post('/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      type: z.string().min(1),
      content: z.string().min(1),
      author: z.string().min(1),
    }).parse(request.body);

    const entry = await svc.addHistory(request.orgId, id, body);
    return reply.status(201).send(entry);
  });

  // POST /api/v1/leads/:id/checklist
  app.post('/:id/checklist', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      itemId: z.string().min(1),
      done: z.boolean(),
    }).parse(request.body);

    return svc.toggleChecklist(request.orgId, id, body.itemId, body.done);
  });
}
