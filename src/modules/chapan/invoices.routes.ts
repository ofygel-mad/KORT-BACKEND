import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as svc from './invoices.service.js';
import { generateBatchInvoiceXlsx } from './invoice.service.js';

export async function chapanInvoicesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  // POST /api/v1/chapan/invoices — Create invoice from order IDs
  app.post('/', async (request, reply) => {
    const body = z.object({
      orderIds: z.array(z.string()).min(1),
      notes: z.string().optional(),
    }).parse(request.body);

    const invoice = await svc.createInvoice(
      request.orgId,
      request.userId,
      request.userFullName,
      body.orderIds,
      body.notes,
    );

    return reply.code(201).send(invoice);
  });

  // GET /api/v1/chapan/invoices — List invoices
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    return svc.listInvoices(request.orgId, {
      status: query.status,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  // GET /api/v1/chapan/invoices/:id — Get single invoice
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getInvoice(request.orgId, id);
  });

  // POST /api/v1/chapan/invoices/:id/confirm-seamstress
  app.post('/:id/confirm-seamstress', async (request) => {
    const { id } = request.params as { id: string };
    return svc.confirmBySeamstress(request.orgId, id, request.userId, request.userFullName);
  });

  // POST /api/v1/chapan/invoices/:id/confirm-warehouse
  app.post('/:id/confirm-warehouse', async (request) => {
    const { id } = request.params as { id: string };
    return svc.confirmByWarehouse(request.orgId, id, request.userId, request.userFullName);
  });

  // POST /api/v1/chapan/invoices/:id/reject
  app.post('/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      reason: z.string().min(1),
    }).parse(request.body);

    await svc.rejectInvoice(request.orgId, id, request.userId, request.userFullName, body.reason);
    return { ok: true };
  });

  // GET /api/v1/chapan/invoices/:id/download — Download XLSX
  app.get('/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { style } = z.object({
      style: z.enum(['default', 'branded']).default('branded'),
    }).parse(request.query);

    const invoice = await svc.getInvoice(request.orgId, id);
    const orderIds = invoice.items.map((item: { orderId: string }) => item.orderId);
    const buffer = await generateBatchInvoiceXlsx(request.orgId, orderIds, style);
    const filename = `nakladnaya-${invoice.invoiceNumber}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });
}
