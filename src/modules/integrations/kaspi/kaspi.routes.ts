import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as service from './kaspi.service.js';

export async function kaspiIntegrationRoutes(app: FastifyInstance) {
  const orgAdminOnly = { preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')] };
  const orgManagerPlus = { preHandler: [app.authenticate, app.resolveOrg, app.requireRole('manager', 'admin', 'owner')] };

  app.get('/connection', orgManagerPlus, async (request) => {
    return service.getConnection(request.orgId);
  });

  app.get('/connections', orgManagerPlus, async (request) => {
    return service.listConnections(request.orgId);
  });

  app.put('/connection', orgAdminOnly, async (request) => {
    const body = z.object({
      apiToken: z.string().min(1).optional(),
      sellerName: z.string().optional(),
      isActive: z.boolean().optional(),
    }).refine(
      (value) => value.apiToken !== undefined || value.sellerName !== undefined || value.isActive !== undefined,
      { message: 'At least one Kaspi connection field must be provided' },
    ).parse(request.body);

    return service.saveConnection(request.orgId, body);
  });

  app.post('/connection/test', orgAdminOnly, async (request) => {
    return service.testConnection(request.orgId);
  });

  app.post('/connection/disconnect', orgAdminOnly, async (request) => {
    return service.disconnectConnection(request.orgId);
  });

  app.post('/sync', orgAdminOnly, async (request) => {
    return service.syncOrders(request.orgId);
  });

  app.get('/orders', orgManagerPlus, async (request) => {
    const query = z.object({
      state: z.string().optional(),
      status: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }).parse(request.query);

    return service.listOrders(request.orgId, query);
  });

  app.get('/orders/summary', orgManagerPlus, async (request) => {
    return service.getOrdersSummary(request.orgId);
  });

  app.get('/orders/:externalOrderId', orgManagerPlus, async (request) => {
    const { externalOrderId } = z.object({
      externalOrderId: z.string().min(1),
    }).parse(request.params);

    return service.getOrderDetail(request.orgId, externalOrderId);
  });

  app.get('/connections/:connectionId/export', orgManagerPlus, async (request, reply) => {
    const { connectionId } = z.object({
      connectionId: z.string().min(1),
    }).parse(request.params);

    const file = await service.exportConnectionOrders(request.orgId, connectionId);
    reply.header('Content-Type', file.contentType);
    reply.header('Content-Disposition', `attachment; filename="${file.filename}"`);
    return reply.send(file.buffer);
  });

  app.post('/orders/:externalOrderId/complete/send-code', orgManagerPlus, async (request) => {
    const { externalOrderId } = z.object({
      externalOrderId: z.string().min(1),
    }).parse(request.params);

    return service.sendCompletionCode(request.orgId, externalOrderId);
  });

  app.post('/orders/:externalOrderId/complete/confirm', orgManagerPlus, async (request) => {
    const { externalOrderId } = z.object({
      externalOrderId: z.string().min(1),
    }).parse(request.params);

    const body = z.object({
      securityCode: z.string().min(1).max(32),
    }).parse(request.body);

    return service.confirmCompletionCode(request.orgId, externalOrderId, body);
  });
}
