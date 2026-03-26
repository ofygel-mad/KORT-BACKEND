import type { FastifyPluginAsync } from 'fastify';
import * as svc from './warehouse.service.js';

function toListResponse<T>(results: T[]) {
  return { count: results.length, results };
}

export const warehouseRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.get('/summary', async (req) => {
    return svc.getWarehouseSummary(req.orgId!);
  });

  app.get('/categories', async (req) => {
    return toListResponse(await svc.listCategories(req.orgId!));
  });

  app.post<{ Body: { name: string; color?: string } }>('/categories', async (req, reply) => {
    const category = await svc.createCategory(req.orgId!, req.body.name, req.body.color);
    return reply.status(201).send(category);
  });

  app.delete<{ Params: { id: string } }>('/categories/:id', async (req, reply) => {
    await svc.deleteCategory(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  app.get('/locations', async (req) => {
    return toListResponse(await svc.listLocations(req.orgId!));
  });

  app.post<{ Body: { name: string } }>('/locations', async (req, reply) => {
    const location = await svc.createLocation(req.orgId!, req.body.name);
    return reply.status(201).send(location);
  });

  app.delete<{ Params: { id: string } }>('/locations/:id', async (req, reply) => {
    await svc.deleteLocation(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  app.get<{
    Querystring: {
      search?: string;
      categoryId?: string;
      locationId?: string;
      lowStock?: string;
      page?: string;
      pageSize?: string;
      limit?: string;
    };
  }>('/items', async (req) => {
    const result = await svc.listItems(req.orgId!, {
      search: req.query.search,
      categoryId: req.query.categoryId,
      locationId: req.query.locationId,
      lowStock: req.query.lowStock === 'true',
      page: req.query.page ? parseInt(req.query.page, 10) : undefined,
      pageSize: req.query.pageSize
        ? parseInt(req.query.pageSize, 10)
        : req.query.limit
          ? parseInt(req.query.limit, 10)
          : undefined,
    });

    return {
      count: result.total,
      page: result.page,
      totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
      results: result.items,
    };
  });

  app.get<{ Params: { id: string } }>('/items/:id', async (req) => {
    return svc.getItem(req.orgId!, req.params.id);
  });

  app.post<{ Body: svc.CreateItemDto }>('/items', async (req, reply) => {
    const authorName = req.userFullName ?? 'Неизвестно';
    const body = req.body;
    const dto: svc.CreateItemDto = {
      ...body,
      qty: body.qty !== undefined ? Number(body.qty) : undefined,
      qtyMin: body.qtyMin !== undefined ? Number(body.qtyMin) : undefined,
      qtyMax: body.qtyMax !== undefined ? Number(body.qtyMax) : undefined,
      costPrice: body.costPrice !== undefined ? Number(body.costPrice) : undefined,
    };
    const item = await svc.createItem(req.orgId!, dto, authorName);
    return reply.status(201).send(item);
  });

  app.patch<{ Params: { id: string }; Body: svc.UpdateItemDto }>('/items/:id', async (req) => {
    const body = req.body;
    const dto: svc.UpdateItemDto = {
      ...body,
      qtyMin: body.qtyMin !== undefined ? Number(body.qtyMin) : undefined,
      qtyMax: body.qtyMax !== undefined ? Number(body.qtyMax) : undefined,
      costPrice: body.costPrice !== undefined ? Number(body.costPrice) : undefined,
    };
    return svc.updateItem(req.orgId!, req.params.id, dto);
  });

  app.delete<{ Params: { id: string } }>('/items/:id', async (req, reply) => {
    await svc.deleteItem(req.orgId!, req.params.id);
    return reply.status(204).send();
  });

  app.get<{
    Querystring: {
      itemId?: string;
      type?: string;
      page?: string;
      pageSize?: string;
      limit?: string;
    };
  }>('/movements', async (req) => {
    const result = await svc.listMovements(req.orgId!, {
      itemId: req.query.itemId,
      type: req.query.type,
      page: req.query.page ? parseInt(req.query.page, 10) : undefined,
      pageSize: req.query.pageSize
        ? parseInt(req.query.pageSize, 10)
        : req.query.limit
          ? parseInt(req.query.limit, 10)
          : undefined,
    });

    return {
      count: result.total,
      page: result.page,
      totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
      results: result.movements,
    };
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

  // POST /api/v1/warehouse/products-availability
  // Body: { names: string[] }
  app.post<{ Body: { names: string[] } }>('/products-availability', async (req) => {
    const { names } = req.body;
    return svc.checkProductNamesAvailability(req.orgId!, Array.isArray(names) ? names : []);
  });

  app.post<{ Params: { orderId: string }; Body?: { reserve?: boolean } }>(
    '/check-order/:orderId',
    async (req) => {
      const reserve = req.body?.reserve ?? true;
      return svc.checkOrderBOM(req.orgId!, req.params.orderId, reserve);
    },
  );

  app.post<{ Params: { orderId: string } }>('/release-order/:orderId', async (req, reply) => {
    await svc.releaseOrderReservations(req.orgId!, req.params.orderId);
    return reply.status(204).send();
  });

  app.get<{ Querystring: { status?: string } }>('/alerts', async (req) => {
    return toListResponse(await svc.listAlerts(req.orgId!, req.query.status));
  });

  app.patch<{ Params: { id: string } }>('/alerts/:id/resolve', async (req) => {
    return svc.resolveAlert(req.orgId!, req.params.id);
  });

  app.get<{ Querystring: { itemId?: string } }>('/lots', async (req) => {
    return toListResponse(await svc.listLots(req.orgId!, req.query.itemId));
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
