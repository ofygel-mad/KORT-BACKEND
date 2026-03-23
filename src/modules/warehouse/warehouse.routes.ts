/**
 * warehouse.routes.ts
 * All warehouse REST endpoints — prefixed at /api/v1/warehouse
 */

import type { FastifyPluginAsync } from 'fastify';
import * as svc from './warehouse.service.js';

export const warehouseRoutes: FastifyPluginAsync = async (app) => {
  // Auth required on all routes
  app.addHook('onRequest', app.authenticate);

  // ── Summary (for tile preview) ──────────────────────────────
  app.get('/summary', async (req) => {
    const orgId = req.orgId!;
    return svc.getWarehouseSummary(orgId);
  });

  // ── Categories ──────────────────────────────────────────────
  app.get('/categories', async (req) => {
    return svc.listCategories(req.orgId!);
  });

  app.post<{ Body: { name: string; color?: string } }>('/categories', async (req, reply) => {
    const cat = await svc.createCategory(req.orgId!, req.body.name, req.body.color);
    return reply.status(201).send(cat);
  });

  app.delete<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    await svc.deleteCategory(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  // ── Locations ────────────────────────────────────────────────
  app.get('/locations', async (req) => {
    return svc.listLocations(req.orgId!);
  });

  app.post<{ Body: { name: string } }>('/locations', async (req, reply) => {
    const loc = await svc.createLocation(req.orgId!, req.body.name);
    return reply.status(201).send(loc);
  });

  app.delete<{ Params: { id: string } }>('/locations/:id', async (req, reply) => {
    await svc.deleteLocation(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  // ── Items ────────────────────────────────────────────────────
  app.get<{
    Querystring: {
      search?: string;
      categoryId?: string;
      locationId?: string;
      lowStock?: string;
      page?: string;
      pageSize?: string;
    };
  }>('/items', async (req) => {
    return svc.listItems(req.orgId!, {
      search: req.query.search,
      categoryId: req.query.categoryId,
      locationId: req.query.locationId,
      lowStock: req.query.lowStock === 'true',
      page: req.query.page ? parseInt(req.query.page) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize) : undefined,
    });
  });

  app.get<{ Params: { id: string } }>('/items/:id', async (req) => {
    return svc.getItem(req.orgId!, req.params.id);
  });

  app.post<{ Body: svc.CreateItemDto }>('/items', async (req, reply) => {
    const authorName = req.userFullName ?? 'Неизвестно';
    const item = await svc.createItem(req.orgId!, req.body, authorName);
    return reply.status(201).send(item);
  });

  app.patch<{ Params: { id: string }; Body: svc.UpdateItemDto }>('/items/:id', async (req) => {
    return svc.updateItem(req.orgId!, req.params.id, req.body);
  });

  app.delete<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    await svc.deleteItem(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  // ── Movements ─────────────────────────────────────────────────
  app.get<{
    Querystring: { itemId?: string; type?: string; page?: string; pageSize?: string };
  }>('/movements', async (req) => {
    return svc.listMovements(req.orgId!, {
      itemId: req.query.itemId,
      type: req.query.type,
      page: req.query.page ? parseInt(req.query.page) : undefined,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize) : undefined,
    });
  });

  app.post<{
    Body: {
      itemId: string;
      type: 'in' | 'out' | 'adjustment' | 'write_off' | 'return';
      qty: number;
      sourceId?: string;
      sourceType?: string;
      reason?: string;
    };
  }>('/movements', async (req, reply) => {
    const authorName = req.userFullName ?? 'Неизвестно';
    await svc.addMovement(req.orgId!, { ...req.body, author: authorName });
    return reply.status(204).send();
  });

  // ── BOM ───────────────────────────────────────────────────────
  app.get('/bom/products', async (req) => {
    return svc.listBOMProducts(req.orgId!);
  });

  app.get<{ Params: { productKey: string } }>('/bom/:productKey', async (req) => {
    return svc.getBOM(req.orgId!, decodeURIComponent(req.params.productKey));
  });

  app.put<{ Body: svc.SetBOMDto }>('/bom', async (req, reply) => {
    await svc.setBOM(req.orgId!, req.body);
    return reply.status(204).send();
  });

  // ── Shortage check (integration with Production) ──────────────
  app.post<{ Params: { orderId: string }; Body?: { reserve?: boolean } }>(
    '/check-order/:orderId',
    async (req) => {
      const reserve = req.body?.reserve ?? true;
      return svc.checkOrderBOM(req.orgId!, req.params.orderId, reserve);
    },
  );

  app.post<{ Params: { orderId: string } }>(
    '/release-order/:orderId',
    async (req, reply) => {
      await svc.releaseOrderReservations(req.orgId!, req.params.orderId);
      return reply.status(204).send();
    },
  );

  // ── Alerts ────────────────────────────────────────────────────
  app.get<{ Querystring: { status?: string } }>('/alerts', async (req) => {
    return svc.listAlerts(req.orgId!, req.query.status);
  });

  app.patch<{ Params: { id: string } }>('/alerts/:id/resolve', async (req) => {
    return svc.resolveAlert(req.orgId!, req.params.id);
  });

  // ── Lots ──────────────────────────────────────────────────────
  app.get<{ Querystring: { itemId?: string } }>('/lots', async (req) => {
    return svc.listLots(req.orgId!, req.query.itemId);
  });

  app.post<{
    Body: {
      itemId: string;
      lotNumber: string;
      qty: number;
      supplier?: string;
      expiresAt?: string;
      notes?: string;
    };
  }>('/lots', async (req, reply) => {
    const authorName = req.userFullName ?? 'Неизвестно';
    const lot = await svc.createLot(req.orgId!, req.body, authorName);
    return reply.status(201).send(lot);
  });
};
