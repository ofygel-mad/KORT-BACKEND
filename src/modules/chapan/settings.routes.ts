import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './settings.service.js';

export async function chapanSettingsRoutes(app: FastifyInstance) {
  // ── Profile ───────────────────────────────────────────
  // GET /api/v1/chapan/settings/profile
  app.get('/profile', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    return svc.getProfile(request.orgId);
  });

  // PATCH /api/v1/chapan/settings/profile
  app.patch('/profile', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request) => {
    return svc.updateProfile(request.orgId, request.body as Record<string, unknown>);
  });

  // ── Catalogs ──────────────────────────────────────────
  // GET /api/v1/chapan/settings/catalogs
  app.get('/catalogs', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    return svc.getCatalogs(request.orgId);
  });

  // PUT /api/v1/chapan/settings/catalogs
  app.put('/catalogs', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const body = z.object({
      productCatalog: z.array(z.string()).optional(),
      fabricCatalog: z.array(z.string()).optional(),
      sizeCatalog: z.array(z.string()).optional(),
      workers: z.array(z.string()).optional(),
    }).parse(request.body);

    await svc.saveCatalogs(request.orgId, body);
    return reply.send({ ok: true });
  });

  // ── Clients ───────────────────────────────────────────
  // GET /api/v1/chapan/settings/clients
  app.get('/clients', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    const clients = await svc.getClients(request.orgId);
    return { count: clients.length, results: clients };
  });

  // POST /api/v1/chapan/settings/clients
  app.post('/clients', { preHandler: [app.authenticate, app.resolveOrg] }, async (request, reply) => {
    const body = z.object({
      fullName: z.string().min(1),
      phone: z.string().min(1),
      email: z.string().optional(),
      company: z.string().optional(),
      notes: z.string().optional(),
    }).parse(request.body);

    const client = await svc.createClient(request.orgId, body);
    return reply.status(201).send(client);
  });
}
