import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './production.service.js';

export async function chapanProductionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/production
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    const tasks = await svc.list(request.orgId, {
      status: query.status,
      assignedTo: query.assignedTo,
    });
    return { count: tasks.length, results: tasks };
  });

  // GET /api/v1/chapan/production/workshop
  // Stripped-down view for workshop_lead/worker (no client data)
  app.get('/workshop', async (request) => {
    const tasks = await svc.listForWorkshop(request.orgId);
    return { count: tasks.length, results: tasks };
  });

  // PATCH /api/v1/chapan/production/:id/status
  app.patch('/:id/status', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status } = z.object({
      status: z.enum(['pending', 'cutting', 'sewing', 'finishing', 'quality_check', 'done']),
    }).parse(request.body);

    await svc.moveStatus(request.orgId, id, status, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // PATCH /api/v1/chapan/production/:id/assign
  app.patch('/:id/assign', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { worker } = z.object({ worker: z.string() }).parse(request.body);
    await svc.assignWorker(request.orgId, id, worker);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/production/:id/flag
  app.post('/:id/flag', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(1) }).parse(request.body);
    await svc.flagTask(request.orgId, id, reason, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // POST /api/v1/chapan/production/:id/unflag
  app.post('/:id/unflag', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.unflagTask(request.orgId, id, request.userId, request.userFullName);
    return reply.send({ ok: true });
  });

  // PATCH /api/v1/chapan/production/:id/defect
  app.patch('/:id/defect', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { defect } = z.object({ defect: z.string() }).parse(request.body);
    await svc.setDefect(request.orgId, id, defect);
    return reply.send({ ok: true });
  });
}
