import type { FastifyInstance } from 'fastify';
import * as svc from './employees.service.js';

export async function employeesRoutes(app: FastifyInstance) {
  const adminOnly = {
    preHandler: [
      app.authenticate,
      app.resolveOrg,
      app.requireRole('admin', 'owner'),
    ],
  };

  // ── GET /api/v1/company/employees ────────────────────────────────────────
  app.get('/employees', adminOnly, async (request) => {
    const employees = await svc.listEmployees(request.orgId);
    return { count: employees.length, results: employees };
  });

  // ── POST /api/v1/company/employees ───────────────────────────────────────
  app.post('/employees', adminOnly, async (request, reply) => {
    const data = svc.createEmployeeSchema.parse(request.body);
    const employee = await svc.createEmployee(
      request.orgId,
      request.userId,
      request.userFullName,
      data,
    );
    return reply.status(201).send(employee);
  });

  // ── PATCH /api/v1/company/employees/:id ──────────────────────────────────
  app.patch('/employees/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const data = svc.updateEmployeeSchema.parse(request.body);
    const employee = await svc.updateEmployee(request.orgId, id, data);
    return reply.send(employee);
  });

  // ── POST /api/v1/company/employees/:id/reset-password ───────────────────
  app.post('/employees/:id/reset-password', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.resetEmployeePassword(request.orgId, id);
    return reply.send(result);
  });

  // ── POST /api/v1/company/employees/:id/dismiss ───────────────────────────
  app.post('/employees/:id/dismiss', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.dismissEmployee(request.orgId, id);
    return reply.send(result);
  });

  // ── DELETE /api/v1/company/employees/:id ─────────────────────────────────
  app.delete('/employees/:id', adminOnly, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await svc.removeEmployee(request.orgId, id);
    return reply.send(result);
  });
}
