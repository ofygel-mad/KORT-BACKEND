import type { FastifyInstance } from 'fastify';
import * as svc from './ownership.service.js';

export async function ownershipRoutes(app: FastifyInstance) {
  app.post('/ownership/transfer', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('owner')],
  }, async (request, reply) => {
    const data = svc.transferOwnershipSchema.parse(request.body);
    const result = await svc.transferOwnership(request.userId, request.orgId, data);
    return reply.send(result);
  });
}
