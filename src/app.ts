import Fastify from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import { config, normalizeCorsOrigin } from './config.js';
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
import { chapanInvoicesRoutes } from './modules/chapan/invoices.routes.js';
import { chapanAttachmentsRoutes } from './modules/chapan/attachments.routes.js';
import { alertsRouter } from './modules/chapan/alerts.routes.js';
import { chapanReturnsRoutes } from './modules/chapan/returns.routes.js';
import { chapanAnalyticsRoutes } from './modules/chapan/analytics.routes.js';
import { chapanPurchaseRoutes } from './modules/chapan/purchase.routes.js';
import { chapanClientsRoutes } from './modules/chapan/clients.routes.js';
// documents routes moved into orders module as /:id/invoice
import { frontendCompatRoutes } from './modules/frontend-compat/frontend-compat.routes.js';
import { employeesRoutes } from './modules/employees/employees.routes.js';
import { accountingRoutes } from './modules/accounting/accounting.routes.js';
import { adsRoutes } from './modules/ads/ads.routes.js';
import { serviceRoutes } from './modules/service/service.routes.js';
import { warehouseRoutes } from './modules/warehouse/warehouse.routes.js';
import { warehouseCatalogRoutes } from './modules/warehouse/warehouse-catalog.routes.js';
import { warehouseFoundationRoutes } from './modules/warehouse/warehouse-foundation.routes.js';
import { warehouseInventoryCoreRoutes } from './modules/warehouse/warehouse-inventory-core.routes.js';
import { warehouseLiveRoutes } from './modules/warehouse/warehouse-live.routes.js';
import { warehouseRuntimeRoutes } from './modules/warehouse/warehouse-runtime.routes.js';
// Chat routes disabled - pending schema migration
// import { chatRoutes } from './modules/chat/chat.routes.js';

export async function buildApp() {
  const isProd = process.env.NODE_ENV === 'production';
  const allowedOrigins = new Set(config.CORS_ORIGINS);
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
  await app.register(compress, {
    global: true,                // compress all routes by default
    encodings: ['br', 'gzip'],  // prefer brotli, fallback to gzip
    threshold: 1024,             // skip compression for responses < 1 KB
  });

  await app.register(cors, {    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      const normalizedOrigin = normalizeCorsOrigin(origin);

      if (allowedOrigins.has(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      app.log.warn({ origin: normalizedOrigin, allowedOrigins: [...allowedOrigins] }, 'Blocked CORS origin');
      callback(null, false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key', 'X-Org-Id'],
  });
  await app.register(rateLimit, {
    max: 300,          // SPA easily fires 5-10 parallel requests per page load
    timeWindow: '1 minute',
    allowList: (request) => request.url.startsWith('/api/v1/sse/'),
    errorResponseBuilder: (_request, context) => ({
      code: 'RATE_LIMIT',
      error: 'RATE_LIMIT',
      message: `Too many requests, retry in ${context.after}`,
      detail: `Too many requests, retry in ${context.after}`,
    }),
  });
  await app.register(sensible);
  await app.register(multipart, { attachFieldsToBody: false });
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

    if (
      typeof error === 'object'
      && error !== null
      && 'statusCode' in error
      && typeof (error as { statusCode?: unknown }).statusCode === 'number'
    ) {
      const statusCode = (error as { statusCode: number }).statusCode;
      const message = error instanceof Error ? error.message : 'Request failed';
      return reply.status(statusCode).send({
        code: statusCode === 429 ? 'RATE_LIMIT' : 'REQUEST_ERROR',
        error: statusCode === 429 ? 'RATE_LIMIT' : 'REQUEST_ERROR',
        message,
        detail: message,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      code: 'INTERNAL',
      error: 'INTERNAL',
      message: 'внутренняя ошибка сервера',
      detail: 'внутренняя ошибка сервера',
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
  await app.register(chapanAttachmentsRoutes, { prefix: '/api/v1/chapan/orders' });
  await app.register(chapanProductionRoutes, { prefix: '/api/v1/chapan/production' });
  await app.register(chapanRequestsRoutes, { prefix: '/api/v1/chapan/requests' });
  await app.register(chapanSettingsRoutes, { prefix: '/api/v1/chapan/settings' });
  await app.register(chapanInvoicesRoutes, { prefix: '/api/v1/chapan/invoices' });
  await app.register(chapanReturnsRoutes, { prefix: '/api/v1/chapan/returns' });
  await app.register(alertsRouter, { prefix: '/api/v1/chapan/alerts' });
  await app.register(chapanAnalyticsRoutes, { prefix: '/api/v1/chapan/analytics' });
  await app.register(chapanPurchaseRoutes, { prefix: '/api/v1/chapan/purchase' });
  await app.register(chapanClientsRoutes, { prefix: '/api/v1/chapan/clients' });
  // invoice generation is now at GET /api/v1/chapan/orders/:id/invoice
  await app.register(frontendCompatRoutes, { prefix: '/api/v1' });


  await app.register(serviceRoutes, { prefix: '/api/v1/service' });
  await app.register(warehouseRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(warehouseCatalogRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(warehouseFoundationRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(warehouseInventoryCoreRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(warehouseRuntimeRoutes, { prefix: '/api/v1/warehouse' });
  await app.register(warehouseLiveRoutes, { prefix: '/api/v1/warehouse-live' });
  await app.register(accountingRoutes, { prefix: '/api/v1/accounting' });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  // Chat routes disabled - pending schema migration
  // await app.register(chatRoutes, { prefix: '/api/v1/chat' });

  // ── Health check ────────────────────────────────────────
  const healthHandler = async () => ({ status: 'ok', ts: new Date().toISOString() });
  app.get('/api/v1/health', healthHandler);
  app.get('/health', healthHandler);
  app.get('/healthz', healthHandler);


  return app;
}
