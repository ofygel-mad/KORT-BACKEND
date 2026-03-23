import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError } from './lib/errors.js';

// Plugins
import authPlugin from './plugins/auth.js';
import orgScopePlugin from './plugins/org-scope.js';

// Modules
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { orgsRoutes } from './modules/orgs/orgs.routes.js';
import { membershipsRoutes } from './modules/memberships/memberships.routes.js';
import { customersRoutes } from './modules/customers/customers.routes.js';
import { leadsRoutes } from './modules/leads/leads.routes.js';
import { dealsRoutes } from './modules/deals/deals.routes.js';
import { tasksRoutes } from './modules/tasks/tasks.routes.js';
import { chapanOrdersRoutes } from './modules/chapan/orders.routes.js';
import { chapanProductionRoutes } from './modules/chapan/production.routes.js';
import { chapanRequestsRoutes } from './modules/chapan/requests.routes.js';
import { chapanSettingsRoutes } from './modules/chapan/settings.routes.js';
import { frontendCompatRoutes } from './modules/frontend-compat/frontend-compat.routes.js';
import { employeesRoutes } from './modules/employees/employees.routes.js';
import { accountingRoutes } from './modules/accounting/accounting.routes.js';
import { serviceRoutes } from './modules/service/service.routes.js';
import { warehouseRoutes } from './modules/warehouse/warehouse.routes.js';

export async function buildApp() {
  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    routerOptions: {
      ignoreTrailingSlash: true,
    },
    logger: isProd
      ? { level: 'info' }
      : {
          level: 'info',
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        },
  });

  // ── Global plugins ──────────────────────────────────────
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key', 'X-Org-Id'],
  });
  await app.register(sensible);
  await app.register(authPlugin);
  await app.register(orgScopePlugin);

  // ── Global error handler ────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        error: error.code,
        message: error.message,
        detail: error.message,
      });
    }

    if (error instanceof ZodError) {
      const detail = error.issues.map((issue) => issue.message).join('; ') || 'Validation failed';
      return reply.status(400).send({
        code: 'VALIDATION',
        error: 'VALIDATION',
        message: detail,
        detail,
      });
    }

    // Fastify validation errors
    if (typeof error === 'object' && error !== null && 'validation' in error) {
      return reply.status(400).send({
        code: 'VALIDATION',
        error: 'VALIDATION',
        message: error instanceof Error ? error.message : 'Validation failed',
        detail: error instanceof Error ? error.message : 'Validation failed',
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      code: 'INTERNAL',
      error: 'INTERNAL',
      message: 'Internal server error',
      detail: 'Internal server error',
    });
  });

  // ── Routes ──────────────────────────────────────────────
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(usersRoutes, { prefix: '/api/v1/users' });
  await app.register(orgsRoutes, { prefix: '/api/v1' });
  await app.register(membershipsRoutes, { prefix: '/api/v1' });
  await app.register(employeesRoutes, { prefix: '/api/v1/company' });
  await app.register(customersRoutes, { prefix: '/api/v1/customers' });
  await app.register(leadsRoutes, { prefix: '/api/v1/leads' });
  await app.register(dealsRoutes, { prefix: '/api/v1/deals' });
  await app.register(tasksRoutes, { prefix: '/api/v1/tasks' });
  await app.register(chapanOrdersRoutes, { prefix: '/api/v1/chapan/orders' });
  await app.register(chapanProductionRoutes, { prefix: '/api/v1/chapan/production' });
  await app.register(chapanRequestsRoutes, { prefix: '/api/v1/chapan/requests' });
  await app.register(chapanSettingsRoutes, { prefix: '/api/v1/chapan/settings' });
  await app.register(frontendCompatRoutes, { prefix: '/api/v1' });


  await app.register(serviceRoutes, { prefix: '/api/v1/service' });
  await app.register(warehouseRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(accountingRoutes, { prefix: '/api/v1/accounting' });

  // ── Health check ────────────────────────────────────────
  app.get('/api/v1/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  return app;
}
