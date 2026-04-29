import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './purchase.service.js';

const itemSchema = z.object({
  productName: z.string().min(1),
  gender: z.string().optional(),
  length: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  quantity: z.number().int().min(1),
  unitPrice: z.number().min(0),
});

const createSchema = z.object({
  type: z.enum(['workshop', 'market']),
  title: z.string().min(1),
  notes: z.string().optional(),
  items: z.array(itemSchema).min(1),
});

export async function chapanPurchaseRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/purchase
  app.get('/', async (request) => {
    const { type } = z.object({ type: z.string().optional() }).parse(request.query);
    const results = await svc.list(request.orgId, type);
    return { count: results.length, results };
  });

  // GET /api/v1/chapan/purchase/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/chapan/purchase
  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const result = await svc.create(
      request.orgId,
      request.userId,
      request.userFullName,
      body,
    );
    return reply.status(201).send(result);
  });

  // PATCH /api/v1/chapan/purchase/:id
  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        notes: z.string().optional(),
        items: z.array(itemSchema).min(1).optional(),
      })
      .parse(request.body);
    return svc.update(request.orgId, id, body);
  });

  // DELETE /api/v1/chapan/purchase/:id
  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.remove(request.orgId, id);
  });

  // GET /api/v1/chapan/purchase/:id/download
  app.get('/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { buffer, filename } = await svc.generateXlsx(request.orgId, id);
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .send(buffer);
  });
}
