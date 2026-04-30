import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { UnauthorizedError } from '../../lib/errors.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { config, normalizeCorsOrigin } from '../../config.js';
import { prisma } from '../../lib/prisma.js';
import * as svc from './frontend-compat.service.js';

export async function frontendCompatRoutes(app: FastifyInstance) {
  const authHandlers = {
    preHandler: [app.authenticate, app.resolveOrg],
  };

  const summaryQuerySchema = z.object({
    date_from: z.string().optional(),
    date_to: z.string().optional(),
  });

  const auditQuerySchema = z.object({
    search: z.string().optional(),
    action: z.string().optional(),
  });

  const searchQuerySchema = z.object({
    q: z.string().trim().min(1),
    limit: z.coerce.number().int().min(1).max(20).default(8),
    types: z.string().optional(),
  });

  const aiChatSchema = z.object({
    message: z.string().trim().min(1),
    customer_id: z.string().optional(),
    deal_id: z.string().optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
        }),
      )
      .optional(),
  });

  const customFieldParamsSchema = z.object({
    entityType: z.enum(['customer', 'deal']),
    entityId: z.string().min(1),
  });

  app.get('/notifications/', authHandlers, async () => {
    return svc.listNotifications();
  });

  app.post('/notifications/read_all/', authHandlers, async () => {
    return svc.markAllNotificationsRead();
  });

  app.get('/reports/dashboard/', authHandlers, async (request) => {
    return svc.getDashboard(request.orgId);
  });

  app.get('/reports/summary/', authHandlers, async (request) => {
    const query = summaryQuerySchema.parse(request.query);
    return svc.getSummary(request.orgId, {
      dateFrom: query.date_from,
      dateTo: query.date_to,
    });
  });

  app.get('/feed/', authHandlers, async (request) => {
    return svc.listFeed(request.orgId);
  });

  app.get('/audit/', authHandlers, async (request) => {
    const query = auditQuerySchema.parse(request.query);
    return svc.listAudit(request.orgId, query);
  });

  app.get('/pipelines/', async () => {
    return svc.listPipelines();
  });

  app.get('/exchange-rates/', async () => {
    return svc.getExchangeRates();
  });

  app.post('/ai/chat/', authHandlers, async (request) => {
    const body = aiChatSchema.parse(request.body);
    return svc.replyFromAssistant(request.orgId, body);
  });

  app.get('/custom-fields/values/:entityType/:entityId/', authHandlers, async (request) => {
    const params = customFieldParamsSchema.parse(request.params);
    return svc.getCustomFieldValues(request.orgId, params);
  });

  app.post('/custom-fields/values/:entityType/:entityId/', authHandlers, async (request) => {
    const params = customFieldParamsSchema.parse(request.params);
    const values = z.record(z.string(), z.unknown()).parse(request.body);
    return svc.saveCustomFieldValues(request.orgId, params, values);
  });

  app.get('/search/', authHandlers, async (request) => {
    const query = searchQuerySchema.parse(request.query);
    return svc.searchWorkspace(request.orgId, query);
  });

  app.get('/sse/', async (request, reply) => {
    const { token } = z
      .object({
        token: z.string().min(1),
      })
      .parse(request.query);

    let userId: string;
    try {
      userId = verifyAccessToken(token).sub;
    } catch {
      throw new UnauthorizedError('Invalid or expired SSE token');
    }

    // JWT doesn't carry orgId — resolve from active membership
    const membership = await prisma.membership.findFirst({
      where: { userId, status: 'active' },
      select: { orgId: true },
    });

    const requestOrigin = typeof request.headers.origin === 'string'
      ? normalizeCorsOrigin(request.headers.origin)
      : null;
    const corsHeaders = requestOrigin && config.CORS_ORIGINS.includes(requestOrigin)
      ? {
          'Access-Control-Allow-Origin': requestOrigin,
          'Access-Control-Allow-Credentials': 'true',
          Vary: 'Origin',
        }
      : {};

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders,
    });

    const send = (event: string, data: unknown) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };

    send('connected', { status: 'ok' });

    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keep-alive\n\n');
    }, 25_000);

    let pollInterval: ReturnType<typeof setInterval> | undefined;

    if (membership) {
      const cursors: svc.EntityCursors = {};
      // Warm up cursors on connect so first tick only emits real changes
      await svc.detectEntityChanges(membership.orgId, cursors).catch(() => {});

      pollInterval = setInterval(() => {
        void svc.detectEntityChanges(membership.orgId, cursors)
          .then((changed) => {
            if (changed.length > 0) send('entity_update', { entities: changed });
          })
          .catch(() => { /* ignore transient DB errors */ });
      }, 15_000);
    }

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      if (pollInterval) clearInterval(pollInterval);
      reply.raw.end();
    });

    return reply;
  });
}
