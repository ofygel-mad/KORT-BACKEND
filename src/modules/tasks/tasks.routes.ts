import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';
import * as svc from './tasks.service.js';

export async function tasksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/tasks
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    const params = {
      ...paginationSchema.parse(query),
      status: query.status,
      priority: query.priority,
      dealId: query.deal_id,
      mine: query.mine === '1',
      dueToday: query.due_today === '1',
      overdue: query.overdue === '1',
    };
    return svc.list(request.orgId, params, {
      userId: request.userId,
      userFullName: request.userFullName,
    });
  });

  // GET /api/v1/tasks/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/tasks
  app.post('/', async (request, reply) => {
    const body = z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      assignedTo: z.string().optional(),
      assignedName: z.string().optional(),
      createdBy: z.string().optional(),
      taskType: z.string().optional(),
      dueDate: z.string().optional(),
      due_at: z.string().optional(),
      dealId: z.string().optional(),
      deal_id: z.string().optional(),
      customer_id: z.string().optional(),
      linkedEntityType: z.string().optional(),
      linkedEntityId: z.string().optional(),
      linkedEntityTitle: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).parse(request.body);

    const task = await svc.create(request.orgId, body, {
      userId: request.userId,
      userFullName: request.userFullName,
    });
    return reply.status(201).send(task);
  });

  // PATCH /api/v1/tasks/:id
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.update(request.orgId, id, request.body as Record<string, unknown>);
  });

  // PATCH /api/v1/tasks/:id/status
  app.patch('/:id/status', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      status: z.enum(['todo', 'in_progress', 'review', 'done', 'open']),
    }).parse(request.body);

    return svc.moveStatus(request.orgId, id, body.status, request.userFullName);
  });

  // POST /api/v1/tasks/:id/complete
  app.post('/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    return svc.complete(request.orgId, id, request.userFullName);
  });

  // POST /api/v1/tasks/:id/subtasks
  app.post('/:id/subtasks', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      title: z.string().min(1),
    }).parse(request.body);

    const sub = await svc.addSubtask(request.orgId, id, body.title);
    return reply.status(201).send(sub);
  });

  // PATCH /api/v1/tasks/:id/subtasks/:subtaskId
  app.patch('/:id/subtasks/:subtaskId', async (request) => {
    const { id, subtaskId } = request.params as { id: string; subtaskId: string };
    const body = z.object({
      done: z.boolean(),
    }).parse(request.body);

    return svc.toggleSubtask(request.orgId, id, subtaskId, body.done);
  });

  // POST /api/v1/tasks/:id/activities
  app.post('/:id/activities', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      type: z.string(),
      content: z.string(),
      author: z.string(),
    }).parse(request.body);

    const activity = await svc.addActivity(request.orgId, id, body);
    return reply.status(201).send(activity);
  });

  // DELETE /api/v1/tasks/:id
  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.remove(request.orgId, id);
  });
}
