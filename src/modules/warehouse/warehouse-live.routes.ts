import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { AppError, UnauthorizedError } from '../../lib/errors.js';
import { verifyAccessToken } from '../../lib/jwt.js';
import { config, normalizeCorsOrigin } from '../../config.js';
import { getWarehouseOrderLiveSnapshot, getWarehouseSiteLiveSnapshot } from './warehouse-projections.service.js';

type SiteLiveSnapshot = Awaited<ReturnType<typeof getWarehouseSiteLiveSnapshot>>;
type OrderLiveSnapshot = Awaited<ReturnType<typeof getWarehouseOrderLiveSnapshot>>;

function buildCorsHeaders(originHeader?: string): Record<string, string> {
  const requestOrigin = typeof originHeader === 'string'
    ? normalizeCorsOrigin(originHeader)
    : null;

  if (!requestOrigin || !config.CORS_ORIGINS.includes(requestOrigin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

async function ensureLiveStreamAccess(input: {
  userId: string;
  orgId: string;
}) {
  const membership = await prisma.membership.findUnique({
    where: {
      userId_orgId: {
        userId: input.userId,
        orgId: input.orgId,
      },
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!membership || membership.status !== 'active') {
    throw new UnauthorizedError('Warehouse live stream requires an active organization membership');
  }
}

function openSse(reply: FastifyReply, corsHeaders: Record<string, string>) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
  });

  return {
    sendEvent(eventName: string, payload: unknown) {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        return;
      }

      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
  };
}

function signatureOf(value: unknown) {
  return JSON.stringify(value);
}

function emitSitePatches(
  previousSnapshot: SiteLiveSnapshot,
  nextSnapshot: SiteLiveSnapshot,
  sendEvent: (eventName: string, payload: unknown) => void,
) {
  let emitted = false;

  if (signatureOf(previousSnapshot.siteFeed) !== signatureOf(nextSnapshot.siteFeed)) {
    emitted = true;
    sendEvent('feed_patch', {
      siteId: nextSnapshot.siteId,
      generatedAt: nextSnapshot.generatedAt,
      siteFeed: nextSnapshot.siteFeed,
    });
  }

  const previousAlertsSignature = signatureOf({
    healthScore: previousSnapshot.controlTower.healthScore,
    alerts: previousSnapshot.controlTower.alerts,
    operations: previousSnapshot.controlTower.operations,
  });
  const nextAlertsSignature = signatureOf({
    healthScore: nextSnapshot.controlTower.healthScore,
    alerts: nextSnapshot.controlTower.alerts,
    operations: nextSnapshot.controlTower.operations,
  });

  if (previousAlertsSignature !== nextAlertsSignature) {
    emitted = true;
    sendEvent('alerts_patch', {
      siteId: nextSnapshot.siteId,
      generatedAt: nextSnapshot.generatedAt,
      controlTower: nextSnapshot.controlTower,
      siteHealth: nextSnapshot.siteHealth,
    });
  }

  const previousOperationsSignature = signatureOf({
    operations: previousSnapshot.controlTower.operations,
    alertClasses: previousSnapshot.controlTower.alertClasses,
    actionableCounters: previousSnapshot.controlTower.actionableCounters,
    actionCards: previousSnapshot.controlTower.actionCards,
    taskQueues: previousSnapshot.controlTower.taskQueues,
    exceptions: previousSnapshot.controlTower.exceptions,
    replenishmentHotspots: previousSnapshot.controlTower.replenishmentHotspots,
    siteMap: previousSnapshot.controlTower.siteMap,
    topReservations: previousSnapshot.controlTower.topReservations,
    recentDocuments: previousSnapshot.controlTower.recentDocuments,
  });
  const nextOperationsSignature = signatureOf({
    operations: nextSnapshot.controlTower.operations,
    alertClasses: nextSnapshot.controlTower.alertClasses,
    actionableCounters: nextSnapshot.controlTower.actionableCounters,
    actionCards: nextSnapshot.controlTower.actionCards,
    taskQueues: nextSnapshot.controlTower.taskQueues,
    exceptions: nextSnapshot.controlTower.exceptions,
    replenishmentHotspots: nextSnapshot.controlTower.replenishmentHotspots,
    siteMap: nextSnapshot.controlTower.siteMap,
    topReservations: nextSnapshot.controlTower.topReservations,
    recentDocuments: nextSnapshot.controlTower.recentDocuments,
  });

  if (previousOperationsSignature !== nextOperationsSignature) {
    emitted = true;
    sendEvent('operations_patch', {
      siteId: nextSnapshot.siteId,
      generatedAt: nextSnapshot.generatedAt,
      controlTower: nextSnapshot.controlTower,
    });
  }

  return emitted;
}

function emitOrderPatches(
  previousSnapshot: OrderLiveSnapshot,
  nextSnapshot: OrderLiveSnapshot,
  sendEvent: (eventName: string, payload: unknown) => void,
) {
  let emitted = false;

  const previousMetricsSignature = signatureOf({
    site: previousSnapshot.warehouseState.site,
    reservationSummary: previousSnapshot.warehouseState.reservationSummary,
    documentSummary: previousSnapshot.warehouseState.documentSummary,
  });
  const nextMetricsSignature = signatureOf({
    site: nextSnapshot.warehouseState.site,
    reservationSummary: nextSnapshot.warehouseState.reservationSummary,
    documentSummary: nextSnapshot.warehouseState.documentSummary,
  });

  if (previousMetricsSignature !== nextMetricsSignature) {
    emitted = true;
    sendEvent('order_metrics_patch', {
      orderId: nextSnapshot.orderId,
      generatedAt: nextSnapshot.generatedAt,
      site: nextSnapshot.warehouseState.site,
      reservationSummary: nextSnapshot.warehouseState.reservationSummary,
      documentSummary: nextSnapshot.warehouseState.documentSummary,
    });
  }

  if (signatureOf(previousSnapshot.warehouseState) !== signatureOf(nextSnapshot.warehouseState)) {
    emitted = true;
    sendEvent('order_state_patch', {
      orderId: nextSnapshot.orderId,
      generatedAt: nextSnapshot.generatedAt,
      warehouseState: nextSnapshot.warehouseState,
    });
  }

  return emitted;
}

export const warehouseLiveRoutes: FastifyPluginAsync = async (app) => {
  app.get('/site-stream', async (request, reply) => {
    const query = z.object({
      token: z.string().min(1),
      orgId: z.string().min(1),
      siteId: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(50).default(12),
    }).parse(request.query);

    let userId = '';

    try {
      userId = verifyAccessToken(query.token).sub;
    } catch {
      throw new UnauthorizedError('Invalid or expired warehouse live token');
    }

    await ensureLiveStreamAccess({
      userId,
      orgId: query.orgId,
    });

    const site = await prisma.warehouseSite.findFirst({
      where: {
        id: query.siteId,
        orgId: query.orgId,
      },
      select: {
        id: true,
      },
    });

    if (!site) {
      throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
    }

    const corsHeaders = buildCorsHeaders(request.headers.origin);
    const { sendEvent } = openSse(reply, corsHeaders);
    let previousSnapshot: SiteLiveSnapshot | null = null;
    let updateTick = 0;

    const sendSiteUpdate = async () => {
      try {
        const snapshot = await getWarehouseSiteLiveSnapshot(query.orgId, query.siteId, query.limit);
        updateTick += 1;

        const emittedPatch = previousSnapshot
          ? emitSitePatches(previousSnapshot, snapshot, sendEvent)
          : false;

        if (!previousSnapshot || !emittedPatch || updateTick % 6 === 0) {
          sendEvent('snapshot', snapshot);
        }

        previousSnapshot = snapshot;
      } catch (error) {
        app.log.error({ error, orgId: query.orgId, siteId: query.siteId }, 'warehouse live snapshot failed');
        sendEvent('error', {
          code: 'WAREHOUSE_LIVE_SNAPSHOT_FAILED',
          message: 'Failed to build warehouse live snapshot',
          generatedAt: new Date().toISOString(),
        });
      }
    };

    sendEvent('connected', {
      status: 'ok',
      orgId: query.orgId,
      siteId: query.siteId,
      generatedAt: new Date().toISOString(),
    });

    await sendSiteUpdate();

    const snapshotInterval = setInterval(() => {
      void sendSiteUpdate();
    }, 10_000);

    const heartbeatInterval = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 25_000);

    request.raw.on('close', () => {
      clearInterval(snapshotInterval);
      clearInterval(heartbeatInterval);
      reply.raw.end();
    });

    return reply;
  });

  app.get('/order-stream', async (request, reply) => {
    const query = z.object({
      token: z.string().min(1),
      orgId: z.string().min(1),
      orderId: z.string().min(1),
    }).parse(request.query);

    let userId = '';

    try {
      userId = verifyAccessToken(query.token).sub;
    } catch {
      throw new UnauthorizedError('Invalid or expired warehouse live token');
    }

    await ensureLiveStreamAccess({
      userId,
      orgId: query.orgId,
    });

    const order = await prisma.chapanOrder.findFirst({
      where: {
        id: query.orderId,
        orgId: query.orgId,
      },
      select: {
        id: true,
      },
    });

    if (!order) {
      throw new AppError(404, 'Заказ не найден', 'NOT_FOUND');
    }

    const corsHeaders = buildCorsHeaders(request.headers.origin);
    const { sendEvent } = openSse(reply, corsHeaders);
    let previousSnapshot: OrderLiveSnapshot | null = null;
    let updateTick = 0;

    const sendOrderUpdate = async () => {
      try {
        const snapshot = await getWarehouseOrderLiveSnapshot(query.orgId, query.orderId);
        updateTick += 1;

        const emittedPatch = previousSnapshot
          ? emitOrderPatches(previousSnapshot, snapshot, sendEvent)
          : false;

        if (!previousSnapshot || !emittedPatch || updateTick % 6 === 0) {
          sendEvent('snapshot', snapshot);
        }

        previousSnapshot = snapshot;
      } catch (error) {
        app.log.error({ error, orgId: query.orgId, orderId: query.orderId }, 'warehouse order live snapshot failed');
        sendEvent('error', {
          code: 'WAREHOUSE_ORDER_LIVE_SNAPSHOT_FAILED',
          message: 'Failed to build warehouse order live snapshot',
          generatedAt: new Date().toISOString(),
        });
      }
    };

    sendEvent('connected', {
      status: 'ok',
      orgId: query.orgId,
      orderId: query.orderId,
      generatedAt: new Date().toISOString(),
    });

    await sendOrderUpdate();

    const snapshotInterval = setInterval(() => {
      void sendOrderUpdate();
    }, 10_000);

    const heartbeatInterval = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 25_000);

    request.raw.on('close', () => {
      clearInterval(snapshotInterval);
      clearInterval(heartbeatInterval);
      reply.raw.end();
    });

    return reply;
  });
};
