import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './returns.service.js';

const returnItemSchema = z.object({
  orderItemId: z.string().optional(),
  productName: z.string().min(1),
  size: z.string().min(1),
  color: z.string().optional(),
  gender: z.string().optional(),
  qty: z.number().int().min(1),
  unitPrice: z.number().min(0),
  refundAmount: z.number().min(0),
  condition: z.enum(['good', 'defective', 'damaged']).default('good'),
  warehouseItemId: z.string().optional(),
});

export async function chapanReturnsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // GET /api/v1/chapan/returns
  app.get('/', async (request) => {
    const query = z.object({
      orderId: z.string().optional(),
      status: z.string().optional(),
    }).parse(request.query);

    const results = await svc.list(request.orgId, query);
    return { count: results.length, results };
  });

  // GET /api/v1/chapan/returns/:id
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getById(request.orgId, id);
  });

  // POST /api/v1/chapan/returns
  app.post('/', async (request, reply) => {
    const body = z.object({
      orderId: z.string().min(1),
      reason: z.enum(['defect', 'wrong_size', 'wrong_item', 'customer_refusal', 'other']),
      reasonNotes: z.string().optional(),
      refundMethod: z.enum(['cash', 'bank']),
      items: z.array(returnItemSchema).min(1),
    }).parse(request.body);

    const result = await svc.create(
      request.orgId,
      request.userId,
      request.userFullName,
      body,
    );
    return reply.status(201).send(result);
  });

  // POST /api/v1/chapan/returns/:id/confirm
  app.post('/:id/confirm', async (request) => {
    const { id } = request.params as { id: string };
    return svc.confirm(request.orgId, id, request.userId, request.userFullName);
  });

  // DELETE /api/v1/chapan/returns/:id
  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.deleteDraft(request.orgId, id);
  });
}
