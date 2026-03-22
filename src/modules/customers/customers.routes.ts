import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '../../lib/pagination.js';
import * as svc from './customers.service.js';

export async function customersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/customers
  app.get('/', async (request) => {
    const params = paginationSchema.parse(request.query);
    return svc.list(request.orgId, params);
  });

  // GET /api/v1/customers/:id/activities
  app.get('/:id/activities', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getActivities(request.orgId, id);
  });

  // GET /api/v1/customers/:id/deals
  app.get('/:id/deals', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getDeals(request.orgId, id);
  });

  // GET /api/v1/customers/:id/tasks
  app.get('/:id/tasks', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getTasks(request.orgId, id);
  });

  // GET /api/v1/customers/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/customers
  app.post('/', async (request, reply) => {
    const body = z.object({
      full_name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      company_name: z.string().optional(),
      notes: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    }).parse(request.body);

    const customer = await svc.create(request.orgId, body);
    return reply.status(201).send(customer);
  });

  // PATCH /api/v1/customers/:id
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.update(request.orgId, id, request.body as Record<string, unknown>);
  });
}
