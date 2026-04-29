import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './clients.service.js';

export async function chapanClientsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/clients
  app.get('/', async (request) => {
    const query = z
      .object({
        search: z.string().optional(),
        customerType: z.enum(['retail', 'wholesale', 'all']).default('all'),
        sortBy: z
          .enum(['name', 'orders', 'spent', 'lastOrder'])
          .default('lastOrder'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    return svc.listClients(request.orgId, query);
  });

  // GET /api/v1/chapan/clients/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getClientDetail(request.orgId, id);
  });

  // PATCH /api/v1/chapan/clients/:id
  app.patch(
    '/:id',
    {
      preHandler: [
        app.authenticate,
        app.resolveOrg,
        app.requireRole('admin', 'owner'),
      ],
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          fullName: z.string().min(1).optional(),
          phone: z.string().min(1).optional(),
          email: z.string().email().optional().nullable(),
          company: z.string().optional().nullable(),
          notes: z.string().optional().nullable(),
        })
        .parse(request.body);

      const updated = await svc.updateClient(request.orgId, id, body);
      return reply.send(updated);
    }
  );
}
