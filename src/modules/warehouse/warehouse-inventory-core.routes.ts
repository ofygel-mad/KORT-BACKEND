import type { FastifyPluginAsync } from 'fastify';
import * as svc from './warehouse-inventory-core.service.js';

export const warehouseInventoryCoreRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.get('/foundation/variants', async (req) => {
    const results = await svc.listVariants(req.orgId!);
    return { count: results.length, results };
  });

  app.post<{ Body: svc.UpsertWarehouseVariantDto }>('/foundation/variants/upsert', async (req, reply) => {
    const variant = await svc.upsertVariant(req.orgId!, req.body);
    return reply.status(201).send(variant);
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { variantId?: string; binId?: string };
  }>('/foundation/sites/:siteId/balances', async (req) => {
    return svc.listSiteBalances(req.orgId!, req.params.siteId, {
      variantId: req.query.variantId,
      binId: req.query.binId,
    });
  });

  app.post<{ Body: svc.PostStockReceiptDto }>('/foundation/inventory/receipts', async (req, reply) => {
    const result = await svc.postStockReceipt(req.orgId!, {
      ...req.body,
      qty: Number(req.body.qty),
      actorUserId: undefined,
      actorName: req.userFullName ?? 'system',
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post<{ Body: svc.PostStockTransferDto }>('/foundation/inventory/transfers', async (req, reply) => {
    const result = await svc.postStockTransfer(req.orgId!, {
      ...req.body,
      qty: Number(req.body.qty),
      actorUserId: undefined,
      actorName: req.userFullName ?? 'system',
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post<{ Body: svc.CreateStockReservationDto }>('/foundation/inventory/reservations', async (req, reply) => {
    const result = await svc.createStockReservation(req.orgId!, {
      ...req.body,
      qty: Number(req.body.qty),
      actorName: req.userFullName ?? 'system',
    });
    return reply.status(result.replayed ? 200 : 201).send(result);
  });

  app.post<{
    Params: { reservationId: string };
    Body?: { reason?: string };
  }>('/foundation/inventory/reservations/:reservationId/release', async (req) => {
    return svc.releaseStockReservation(
      req.orgId!,
      req.params.reservationId,
      req.userFullName ?? 'system',
      req.body?.reason,
    );
  });

  app.post<{
    Params: { reservationId: string };
    Body?: { reason?: string };
  }>('/foundation/inventory/reservations/:reservationId/consume', async (req) => {
    return svc.consumeStockReservation(
      req.orgId!,
      req.params.reservationId,
      req.userFullName ?? 'system',
      req.body?.reason,
    );
  });
};
