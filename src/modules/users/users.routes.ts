import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as usersService from './users.service.js';

export async function usersRoutes(app: FastifyInstance) {
  // GET /api/v1/users/me
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    return usersService.getMe(request.userId);
  });

  // GET /api/v1/users/team
  app.get('/team', { preHandler: [app.authenticate, app.resolveOrg] }, async (request) => {
    const team = await usersService.getTeam(request.orgId);
    return { count: team.length, results: team };
  });

  // PATCH /api/v1/users/:id/role
  app.patch('/:id/role', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { role } = z.object({ role: z.enum(['owner', 'admin', 'manager', 'viewer']) }).parse(request.body);
    await usersService.updateUserRole(id, request.orgId, role);
    return reply.send({ ok: true });
  });

  // POST /api/v1/users/:id/activate
  app.post('/:id/activate', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await usersService.activateUser(id, request.orgId);
    return reply.send({ ok: true });
  });

  // POST /api/v1/users/:id/deactivate
  app.post('/:id/deactivate', {
    preHandler: [app.authenticate, app.resolveOrg, app.requireRole('admin', 'owner')],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await usersService.deactivateUser(id, request.orgId);
    return reply.send({ ok: true });
  });
  // POST /api/v1/users/me/change-email
  app.post('/me/change-email', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { new_email, current_password } = z.object({
      new_email: z.string().min(3),
      current_password: z.string().min(1),
    }).parse(request.body);

    await usersService.changeEmail(request.userId, new_email, current_password);
    // Tokens are revoked in service — client must re-login
    return reply.send({ ok: true, requires_relogin: true });
  });
}
