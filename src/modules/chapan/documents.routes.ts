import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './documents.service.js';

export async function chapanDocumentsRoutes(app: FastifyInstance) {
  console.log('🟢 [documents] registering chapan documents routes');

  // DEBUG: test route without auth
  app.get('/ping', async () => ({ ok: true, module: 'documents' }));

  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  /**
   * GET /api/v1/chapan/documents/invoice/:orderId?style=branded|default
   * Returns an .xlsx file for the given order.
   */
  app.get('/invoice/:orderId', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const { style } = z.object({
      style: z.enum(['default', 'branded']).default('branded'),
    }).parse(request.query);

    app.log.info({ orderId, orgId: request.orgId, style }, 'Invoice generation requested');

    let buffer: Buffer;
    try {
      buffer = await svc.generateInvoiceXlsx(request.orgId, orderId, style);
    } catch (err) {
      app.log.error({ err, orderId, orgId: request.orgId }, 'Invoice generation failed');
      throw err;
    }
    const filename = `nakladnaya-${orderId.slice(0, 8)}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });
}
