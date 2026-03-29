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
      documentPayload: z.unknown().optional(),
    }).parse(request.body);

    const invoice = await svc.createInvoice(
      request.orgId,
      request.userId,
      request.userFullName,
      body.orderIds,
      body.notes,
      body.documentPayload,
    );

    return reply.code(201).send(invoice);
  });

  app.post('/preview', async (request) => {
    const body = z.object({
      orderIds: z.array(z.string()).min(1),
    }).parse(request.body);

    return svc.previewInvoiceDocument(request.orgId, body.orderIds);
  });

  // GET /api/v1/chapan/invoices — List invoices
  app.get('/', async (request) => {
    const query = request.query as Record<string, string>;
    return svc.listInvoices(request.orgId, {
      status: query.status,
      orderId: query.orderId,
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
  });

  // GET /api/v1/chapan/invoices/:id — Get single invoice
  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    return svc.getInvoice(request.orgId, id);
  });

  // PATCH /api/v1/chapan/invoices/:id/document — Save preview/editor changes
  app.patch('/:id/document', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      documentPayload: z.unknown(),
    }).parse(request.body);

    return svc.updateInvoiceDocument(request.orgId, id, body.documentPayload);
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

  // POST /api/v1/chapan/invoices/:id/archive — Archive after download
  app.post('/:id/archive', async (request, reply) => {
    const { id } = request.params as { id: string };
    await svc.archiveInvoice(request.orgId, id);
    return reply.send({ ok: true });
  });

  // GET /api/v1/chapan/invoices/:id/download — Download XLSX
  app.get('/:id/download', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { style } = z.object({
      style: z.enum(['default', 'branded']).default('branded'),
    }).parse(request.query);

    const invoice = await svc.getInvoice(request.orgId, id);
    const orderIds = invoice.items.map((item: { orderId: string }) => item.orderId);
    const buffer = await generateBatchInvoiceXlsx(request.orgId, orderIds, style, {
      invoiceNumber: invoice.invoiceNumber,
      createdAt: new Date(invoice.createdAt),
    }, invoice.documentPayload);
    const filename = `nakladnaya-${invoice.invoiceNumber}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header('Cache-Control', 'no-store')
      .send(buffer);
  });
}
