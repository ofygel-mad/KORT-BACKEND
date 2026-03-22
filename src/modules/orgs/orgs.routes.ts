import type { FastifyInstance } from 'fastify';
import * as orgsService from './orgs.service.js';

export async function orgsRoutes(app: FastifyInstance) {
  // GET /api/v1/organization
  app.get('/organization', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    return orgsService.getOrganization(request.orgId);
  });

  // PATCH /api/v1/organization
  app.patch('/organization', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request) => {
    return orgsService.updateOrganization(request.orgId, request.body as Record<string, unknown>);
  });

  // GET /api/v1/companies/search?q=
  app.get('/companies/search', async (request) => {
    const { q } = request.query as { q?: string };
    const results = await orgsService.searchCompanies(q ?? '');
    return { count: results.length, results };
  });
}
