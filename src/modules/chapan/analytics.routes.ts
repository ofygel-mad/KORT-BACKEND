import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './analytics.service.js';

export async function chapanAnalyticsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.get('/overview', async (request) => {
    const { dateFrom, dateTo } = z
      .object({
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      })
      .parse(request.query);

    return svc.getOverview(
      request.orgId,
      dateFrom ? new Date(dateFrom) : undefined,
      dateTo ? new Date(dateTo) : undefined,
    );
  });
}
