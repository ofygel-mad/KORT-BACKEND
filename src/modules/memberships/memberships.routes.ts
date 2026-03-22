import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './memberships.service.js';
import { acceptInviteAndBuildSession } from '../auth/auth.service.js';

export async function membershipsRoutes(app: FastifyInstance) {
  // POST /api/v1/membership-requests
  app.post('/membership-requests', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { company_id } = z.object({ company_id: z.string() }).parse(request.body);
    const result = await svc.submitMembershipRequest(
      request.userId, request.userFullName ?? '', request.userEmail, company_id,
    );
    return reply.send(result);
  });

  // GET /api/v1/membership-requests/me
  app.get('/membership-requests/me', { preHandler: [app.authenticate] }, async (request) => {
    const results = await svc.getMyRequests(request.userId);
    return { count: results.length, results };
  });

  // GET /api/v1/admin/membership-requests
  app.get('/admin/membership-requests', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request) => {
    const results = await svc.getAdminRequests(request.orgId);
    return { count: results.length, results };
  });

  // POST /api/v1/admin/membership-requests/:id/approve
  app.post('/admin/membership-requests/:id/approve', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.approveRequest(id, request.orgId);
    return reply.send({ ok: true });
  });

  // POST /api/v1/admin/membership-requests/:id/reject
  app.post('/admin/membership-requests/:id/reject', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.rejectRequest(id, request.orgId);
    return reply.send({ ok: true });
  });

  // POST /api/v1/admin/invites
  app.post('/admin/invites', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { role, kind } = z.object({
      role: z.enum(['owner', 'admin', 'manager', 'viewer']).default('manager'),
      kind: z.enum(['invite', 'referral']).default('referral'),
    }).parse(request.body);

    // Need org name/slug — fetch it
    const org = await import('../../lib/prisma.js').then(({ prisma }) =>
      prisma.organization.findUniqueOrThrow({ where: { id: request.orgId } })
    );

    const result = await svc.createInvite(request.orgId, org.name, org.slug, request.userId, role, kind);
    return reply.send(result);
  });

  // GET /api/v1/admin/invites
  app.get('/admin/invites', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request) => {
    const results = await svc.listInvites(request.orgId);
    return { count: results.length, results };
  });

  // GET /api/v1/invites/:token
  app.get('/invites/:token', async (request) => {
    const { token } = request.params as { token: string };
    return svc.getInvite(token);
  });

  // POST /api/v1/invites/:token/accept
  app.post('/invites/:token/accept', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const session = await acceptInviteAndBuildSession(request.userId, token);
    return reply.send(session);
  });
}
