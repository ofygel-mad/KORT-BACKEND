import type { FastifyPluginAsync } from 'fastify';
import * as svc from './warehouse-foundation.service.js';
import * as projectionSvc from './warehouse-projections.service.js';

export const warehouseFoundationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.get('/foundation/status', async (req) => {
    return svc.getFoundationStatus(req.orgId!);
  });

  app.get('/foundation/sites', async (req) => {
    const results = await svc.listSites(req.orgId!);
    return { count: results.length, results };
  });

  app.post<{ Body: svc.CreateWarehouseSiteDto }>('/foundation/sites', async (req, reply) => {
    const site = await svc.createSite(req.orgId!, req.body, req.userFullName);
    return reply.status(201).send(site);
  });

  app.get<{ Params: { id: string } }>('/foundation/sites/:id/structure', async (req) => {
    return svc.getSiteStructure(req.orgId!, req.params.id);
  });

  app.get<{ Params: { siteId: string } }>('/foundation/sites/:siteId/health', async (req) => {
    return projectionSvc.getSiteHealthSnapshot(req.orgId!, req.params.siteId);
  });

  app.get<{ Params: { siteId: string } }>('/foundation/sites/:siteId/control-tower', async (req) => {
    return projectionSvc.getWarehouseSiteControlTower(req.orgId!, req.params.siteId);
  });

  app.post<{ Params: { siteId: string }; Body: svc.CreateWarehouseZoneDto }>(
    '/foundation/sites/:siteId/zones',
    async (req, reply) => {
      const zone = await svc.createZone(req.orgId!, req.params.siteId, req.body);
      return reply.status(201).send(zone);
    },
  );

  app.post<{
    Params: { siteId: string };
    Body: Omit<svc.CreateWarehouseBinDto, 'capacityUnits' | 'capacityWeight' | 'capacityVolume'> & {
      capacityUnits?: number | string;
      capacityWeight?: number | string;
      capacityVolume?: number | string;
    };
  }>('/foundation/sites/:siteId/bins', async (req, reply) => {
    const body = req.body;
    const dto: svc.CreateWarehouseBinDto = {
      ...body,
      capacityUnits: body.capacityUnits !== undefined ? Number(body.capacityUnits) : undefined,
      capacityWeight: body.capacityWeight !== undefined ? Number(body.capacityWeight) : undefined,
      capacityVolume: body.capacityVolume !== undefined ? Number(body.capacityVolume) : undefined,
    };

    const bin = await svc.createBin(req.orgId!, req.params.siteId, dto);
    return reply.status(201).send(bin);
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { status?: string };
  }>('/foundation/sites/:siteId/reservations', async (req) => {
    return projectionSvc.listSiteReservations(req.orgId!, req.params.siteId, {
      status: req.query.status,
    });
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { documentType?: string };
  }>('/foundation/sites/:siteId/documents', async (req) => {
    return projectionSvc.listSiteOperationDocuments(req.orgId!, req.params.siteId, {
      documentType: req.query.documentType,
    });
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { limit?: string };
  }>('/foundation/sites/:siteId/feed', async (req) => {
    const parsedLimit = req.query.limit ? Number(req.query.limit) : undefined;
    return projectionSvc.getSiteFeed(req.orgId!, req.params.siteId, parsedLimit);
  });

  app.get('/foundation/system/outbox', async (req) => {
    return projectionSvc.getOutboxRuntimeStatus(req.orgId!);
  });
};
