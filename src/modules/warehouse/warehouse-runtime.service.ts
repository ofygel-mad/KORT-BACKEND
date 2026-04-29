import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { postStockTransfer } from './warehouse-inventory-core.service.js';

type Tx = Prisma.TransactionClient | PrismaClient;

type LayoutNodeDraft = {
  id: string;
  orgId: string;
  warehouseSiteId: string;
  layoutVersionId: string;
  zoneId?: string | null;
  binId?: string | null;
  parentNodeId?: string | null;
  nodeType: string;
  domainType: string;
  domainId: string;
  label?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  hidden: boolean;
  metadataJson?: Prisma.InputJsonValue;
};

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asRecord(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function normalizeNotes(value?: string | null) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function addMinutes(base: Date, minutes: number) {
  return new Date(base.getTime() + (minutes * 60_000));
}

function computeSlaStatus(status: string, dueAt?: Date | null, now = new Date()) {
  if (['completed', 'cancelled', 'resolved'].includes(status)) {
    return 'closed';
  }

  if (!dueAt) {
    return 'on_track';
  }

  const diff = dueAt.getTime() - now.getTime();
  if (diff <= 0) {
    return 'breached';
  }
  if (diff <= 30 * 60_000) {
    return 'at_risk';
  }
  return 'on_track';
}

function deriveTaskDueAt(taskType: string, priority: string, now: Date) {
  if (taskType === 'pick') {
    return addMinutes(now, priority === 'high' ? 20 : 75);
  }
  if (taskType === 'replenishment') {
    return addMinutes(now, priority === 'high' ? 25 : 120);
  }
  if (taskType === 'putaway') {
    return addMinutes(now, 240);
  }
  return addMinutes(now, 180);
}

function deriveExceptionDueAt(severity: string, now: Date) {
  if (severity === 'critical') return addMinutes(now, 20);
  if (severity === 'warning') return addMinutes(now, 120);
  return addMinutes(now, 360);
}

function toFiniteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number; hidden?: boolean },
  right: { x: number; y: number; width: number; height: number; hidden?: boolean },
) {
  if (left.hidden || right.hidden) {
    return false;
  }

  return !(
    left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y
  );
}

function buildPublishPolicy(input: {
  hardBlockers: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  taskImpactMatrix: Array<Record<string, unknown>>;
}) {
  const forceableCodes = new Set([
    'layout.active_task_impacted',
  ]);

  const hardBlockerCodes = input.hardBlockers
    .map((entry) => (typeof entry.code === 'string' ? entry.code : null))
    .filter(Boolean) as string[];
  const nonForceableBlockers = input.hardBlockers.filter((entry) => !forceableCodes.has(String(entry.code ?? '')));
  const canPublish = input.hardBlockers.length === 0;
  const canForcePublish = !canPublish && input.hardBlockers.length > 0 && nonForceableBlockers.length === 0;
  const reviewRequiredCount = input.taskImpactMatrix.filter((entry) => entry.impactLevel === 'review_required').length;

  return {
    canPublish,
    canForcePublish,
    requiresSupervisorReview: input.warnings.length > 0 || reviewRequiredCount > 0 || canForcePublish,
    blockedBy: Array.from(new Set(hardBlockerCodes)),
    forceActions: canForcePublish
      ? [
        'pause_impacted_execution',
        'recompute_routes_after_publish',
        'broadcast_supervisor_migration_notice',
      ]
      : [],
  };
}

async function createOutboxRecord(tx: Prisma.TransactionClient, input: {
  orgId: string;
  warehouseSiteId?: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  await tx.warehouseOutbox.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId ?? null,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

async function ensureAssigneePools(tx: Tx, orgId: string, siteId: string) {
  const defaults = [
    { code: 'picker', name: 'Pick Crew', poolType: 'pick', capacityLimit: 12 },
    { code: 'putaway', name: 'Putaway Crew', poolType: 'putaway', capacityLimit: 10 },
    { code: 'replenishment', name: 'Replenishment Crew', poolType: 'replenishment', capacityLimit: 8 },
    { code: 'supervisor', name: 'Supervisor Desk', poolType: 'exception', capacityLimit: 20 },
  ] as const;

  for (const pool of defaults) {
    await tx.warehouseAssigneePool.upsert({
      where: {
        warehouseSiteId_code: {
          warehouseSiteId: siteId,
          code: pool.code,
        },
      },
      update: {
        name: pool.name,
        poolType: pool.poolType,
        active: true,
        capacityLimit: pool.capacityLimit,
      },
      create: {
        orgId,
        warehouseSiteId: siteId,
        code: pool.code,
        name: pool.name,
        poolType: pool.poolType,
        active: true,
        capacityLimit: pool.capacityLimit,
      },
    });
  }

  return tx.warehouseAssigneePool.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      active: true,
    },
    orderBy: [{ poolType: 'asc' }, { code: 'asc' }],
  });
}

async function appendTaskEvent(tx: Prisma.TransactionClient, input: {
  orgId: string;
  warehouseSiteId: string;
  taskId: string;
  eventType: string;
  actorName?: string | null;
  payload?: Record<string, unknown>;
}) {
  await tx.warehouseTaskEvent.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId,
      taskId: input.taskId,
      eventType: input.eventType,
      actorName: input.actorName ?? null,
      payloadJson: input.payload ? (input.payload as Prisma.InputJsonValue) : undefined,
    },
  });
}

async function appendExceptionEvent(tx: Prisma.TransactionClient, input: {
  orgId: string;
  warehouseSiteId: string;
  exceptionId: string;
  eventType: string;
  actorName?: string | null;
  payload?: Record<string, unknown>;
}) {
  await tx.warehouseExceptionEvent.create({
    data: {
      orgId: input.orgId,
      warehouseSiteId: input.warehouseSiteId,
      exceptionId: input.exceptionId,
      eventType: input.eventType,
      actorName: input.actorName ?? null,
      payloadJson: input.payload ? (input.payload as Prisma.InputJsonValue) : undefined,
    },
  });
}

async function ensureSiteAccess<T extends Tx>(db: T, orgId: string, siteId: string) {
  const site = await db.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: {
      id: true,
      code: true,
      name: true,
      publishedLayoutVersionId: true,
    },
  });

  if (!site) {
    throw new AppError(404, 'Склад не найден', 'NOT_FOUND');
  }

  return site;
}

async function resolveLiveLayoutVersion<T extends Tx>(db: T, orgId: string, siteId: string) {
  const site = await ensureSiteAccess(db, orgId, siteId);

  if (site.publishedLayoutVersionId) {
    const live = await db.warehouseLayoutVersion.findFirst({
      where: {
        id: site.publishedLayoutVersionId,
        orgId,
        warehouseSiteId: siteId,
      },
    });

    if (live) {
      return live;
    }
  }

  const fallback = await db.warehouseLayoutVersion.findFirst({
    where: {
      orgId,
      warehouseSiteId: siteId,
    },
    orderBy: [{ publishedAt: 'desc' }, { versionNo: 'desc' }],
  });

  if (!fallback) {
    throw new AppError(404, 'Live layout version not found', 'NOT_FOUND');
  }

  return fallback;
}

function buildLayoutBlueprint(input: {
  orgId: string;
  siteId: string;
  layoutVersionId: string;
  zones: Array<{
    id: string;
    code: string;
    name: string;
    zoneType: string;
  }>;
  bins: Array<{
    id: string;
    zoneId: string;
    code: string;
    binType: string;
    pickFaceEnabled: boolean;
  }>;
}) {
  const byZone = new Map<string, typeof input.bins>();

  for (const bin of input.bins) {
    const list = byZone.get(bin.zoneId) ?? [];
    list.push(bin);
    byZone.set(bin.zoneId, list);
  }

  for (const list of byZone.values()) {
    list.sort((left, right) => left.code.localeCompare(right.code));
  }

  const nodes: LayoutNodeDraft[] = [];
  const zoneColumns = 3;
  const zoneGapX = 1.4;
  const zoneGapY = 1.8;

  input.zones.forEach((zone, index) => {
    const zoneBins = byZone.get(zone.id) ?? [];
    const column = index % zoneColumns;
    const row = Math.floor(index / zoneColumns);
    const binColumns = 3;
    const zoneWidth = 5.2;
    const zoneHeight = Math.max(3.1, 1.8 + Math.ceil(Math.max(zoneBins.length, 1) / binColumns) * 1.1);
    const zoneNodeId = randomUUID();
    const zoneX = column * (zoneWidth + zoneGapX);
    const zoneY = row * (zoneHeight + zoneGapY);

    nodes.push({
      id: zoneNodeId,
      orgId: input.orgId,
      warehouseSiteId: input.siteId,
      layoutVersionId: input.layoutVersionId,
      zoneId: zone.id,
      nodeType: 'zone',
      domainType: 'warehouse.zone',
      domainId: zone.id,
      label: zone.code,
      x: zoneX,
      y: zoneY,
      width: zoneWidth,
      height: zoneHeight,
      rotation: 0,
      zIndex: 10,
      hidden: false,
      metadataJson: asJson({
        code: zone.code,
        name: zone.name,
        zoneType: zone.zoneType,
      }),
    });

    zoneBins.forEach((bin, binIndex) => {
      const localColumn = binIndex % binColumns;
      const localRow = Math.floor(binIndex / binColumns);

      nodes.push({
        id: randomUUID(),
        orgId: input.orgId,
        warehouseSiteId: input.siteId,
        layoutVersionId: input.layoutVersionId,
        zoneId: zone.id,
        binId: bin.id,
        parentNodeId: zoneNodeId,
        nodeType: 'bin',
        domainType: 'warehouse.bin',
        domainId: bin.id,
        label: bin.code,
        x: zoneX + 0.45 + localColumn * 1.45,
        y: zoneY + 1.0 + localRow * 1.05,
        width: 1.12,
        height: 0.82,
        rotation: 0,
        zIndex: 20,
        hidden: false,
        metadataJson: asJson({
          code: bin.code,
          binType: bin.binType,
          pickFaceEnabled: bin.pickFaceEnabled,
        }),
      });
    });
  });

  return nodes;
}

async function bootstrapLayoutNodesForVersion(tx: Prisma.TransactionClient, input: {
  orgId: string;
  siteId: string;
  layoutVersionId: string;
}) {
  const [existing, zones, bins] = await Promise.all([
    tx.warehouseLayoutNode.count({
      where: {
        orgId: input.orgId,
        warehouseSiteId: input.siteId,
        layoutVersionId: input.layoutVersionId,
      },
    }),
    tx.warehouseZone.findMany({
      where: { orgId: input.orgId, warehouseSiteId: input.siteId },
      select: {
        id: true,
        code: true,
        name: true,
        zoneType: true,
      },
      orderBy: [{ code: 'asc' }],
    }),
    tx.warehouseBin.findMany({
      where: { orgId: input.orgId, warehouseSiteId: input.siteId },
      select: {
        id: true,
        zoneId: true,
        code: true,
        binType: true,
        pickFaceEnabled: true,
      },
      orderBy: [{ code: 'asc' }],
    }),
  ]);

  if (existing > 0) {
    return existing;
  }

  const nodes = buildLayoutBlueprint({
    orgId: input.orgId,
    siteId: input.siteId,
    layoutVersionId: input.layoutVersionId,
    zones,
    bins,
  });

  if (nodes.length === 0) {
    return 0;
  }

  await tx.warehouseLayoutNode.createMany({
    data: nodes,
  });

  return nodes.length;
}

export async function ensureLiveLayoutNodes(orgId: string, siteId: string, tx?: Tx) {
  const db = tx ?? prisma;
  const live = await resolveLiveLayoutVersion(db, orgId, siteId);

  if (tx) {
    await bootstrapLayoutNodesForVersion(tx, {
      orgId,
      siteId,
      layoutVersionId: live.id,
    });
  } else {
    await prisma.$transaction(async (innerTx) => {
      await bootstrapLayoutNodesForVersion(innerTx, {
        orgId,
        siteId,
        layoutVersionId: live.id,
      });
    });
  }

  return live;
}

function makeTaskTitle(taskType: string, label: string) {
  if (taskType === 'pick') return `Pick ${label}`;
  if (taskType === 'putaway') return `Putaway ${label}`;
  return `Replenish ${label}`;
}

function makeTaskPriority(level: 'critical' | 'warning' | 'info') {
  if (level === 'critical') return 'high';
  if (level === 'warning') return 'normal';
  return 'low';
}

export async function syncWarehouseOperationalState(orgId: string, siteId: string, tx?: Tx) {
  const executor = tx ?? prisma;
  const now = new Date();

  const site = await ensureSiteAccess(executor, orgId, siteId);
  const assigneePools = await ensureAssigneePools(executor, orgId, siteId);
  const poolByType = new Map(assigneePools.map((pool) => [pool.poolType, pool]));

  const [zones, bins, balanceRows, activeReservations, existingTasks, existingExceptions] = await Promise.all([
    executor.warehouseZone.findMany({
      where: { orgId, warehouseSiteId: siteId },
      select: {
        id: true,
        code: true,
        name: true,
        zoneType: true,
        status: true,
        _count: {
          select: {
            bins: true,
          },
        },
      },
      orderBy: [{ code: 'asc' }],
    }),
    executor.warehouseBin.findMany({
      where: { orgId, warehouseSiteId: siteId },
      select: {
        id: true,
        code: true,
        zoneId: true,
        status: true,
        binType: true,
        pickFaceEnabled: true,
        capacityUnits: true,
        zone: {
          select: {
            id: true,
            code: true,
            name: true,
            zoneType: true,
          },
        },
      },
      orderBy: [{ code: 'asc' }],
    }),
    executor.warehouseStockBalance.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        OR: [
          { qtyOnHand: { gt: 0 } },
          { qtyReserved: { gt: 0 } },
          { qtyAvailable: { gt: 0 } },
        ],
      },
      select: {
        id: true,
        binId: true,
        variantId: true,
        qtyOnHand: true,
        qtyReserved: true,
        qtyAvailable: true,
        bin: {
          select: {
            id: true,
            code: true,
            zoneId: true,
            binType: true,
            pickFaceEnabled: true,
            capacityUnits: true,
            zone: {
              select: {
                id: true,
                code: true,
                name: true,
                zoneType: true,
              },
            },
          },
        },
        variant: {
          select: {
            id: true,
            variantKey: true,
            attributesSummary: true,
            productCatalog: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    }),
    executor.warehouseStockReservation.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: 'active',
      },
      include: {
        variant: {
          include: {
            productCatalog: {
              select: {
                name: true,
              },
            },
          },
        },
        allocations: {
          include: {
            bin: {
              select: {
                id: true,
                code: true,
                zoneId: true,
                zone: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    zoneType: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    executor.warehouseTask.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        sourceStrategy: 'system.materialized',
      },
      select: {
        id: true,
        externalKey: true,
        status: true,
        assigneeName: true,
        assigneeRole: true,
        assignedAt: true,
        assigneePoolId: true,
        startedAt: true,
        completedAt: true,
      },
    }),
    executor.warehouseException.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        sourceStrategy: 'system.materialized',
      },
      select: {
        id: true,
        externalKey: true,
        status: true,
        ownerName: true,
        ownerRole: true,
        assignedAt: true,
        ownerPoolId: true,
        resolvedAt: true,
      },
    }),
  ]);

  const balancesByBin = new Map<string, typeof balanceRows>();
  for (const row of balanceRows) {
    const list = balancesByBin.get(row.binId) ?? [];
    list.push(row);
    balancesByBin.set(row.binId, list);
  }

  const desiredTasks = new Map<string, Prisma.WarehouseTaskUncheckedCreateInput>();
  const desiredExceptions = new Map<string, Prisma.WarehouseExceptionUncheckedCreateInput>();

  for (const zone of zones) {
    if (zone._count.bins === 0) {
      const dueAt = deriveExceptionDueAt('warning', now);
      desiredExceptions.set(`structure-gap:${zone.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: zone.id,
        ownerPoolId: poolByType.get('exception')?.id ?? null,
        sourceType: 'warehouse_zone',
        sourceId: zone.id,
        exceptionType: 'structure_gap',
        severity: 'warning',
        status: 'open',
        dueAt,
        slaStatus: computeSlaStatus('open', dueAt, now),
        title: `Zone ${zone.code} has no bins`,
        description: 'This zone exists in the warehouse layout but still has no addressable storage cells.',
        sourceStrategy: 'system.materialized',
        externalKey: `structure-gap:${zone.id}`,
        metadataJson: asJson({
          zoneCode: zone.code,
          zoneType: zone.zoneType,
        }),
      });
    }
  }

  for (const bin of bins) {
    const rows = balancesByBin.get(bin.id) ?? [];
    const qtyOnHand = rows.reduce((sum, row) => sum + row.qtyOnHand, 0);
    const qtyAvailable = rows.reduce((sum, row) => sum + row.qtyAvailable, 0);
    const qtyReserved = rows.reduce((sum, row) => sum + row.qtyReserved, 0);
    const topRow = [...rows].sort((left, right) => (
      right.qtyReserved - left.qtyReserved
      || right.qtyOnHand - left.qtyOnHand
    ))[0];

    if (bin.status !== 'active') {
      const dueAt = deriveExceptionDueAt('critical', now);
      desiredExceptions.set(`blocked-bin:${bin.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: bin.zoneId,
        binId: bin.id,
        variantId: topRow?.variantId ?? null,
        ownerPoolId: poolByType.get('exception')?.id ?? null,
        sourceType: 'warehouse_bin',
        sourceId: bin.id,
        exceptionType: 'blocked_bin',
        severity: 'critical',
        status: 'open',
        dueAt,
        slaStatus: computeSlaStatus('open', dueAt, now),
        title: `Blocked bin ${bin.code}`,
        description: `${bin.zone.code} contains a non-active bin and needs supervisor attention.`,
        sourceStrategy: 'system.materialized',
        externalKey: `blocked-bin:${bin.id}`,
        metadataJson: asJson({
          zoneCode: bin.zone.code,
          binType: bin.binType,
        }),
      });
    }

    if (qtyReserved > 0 && qtyAvailable <= 0) {
      const dueAt = deriveExceptionDueAt('critical', now);
      desiredExceptions.set(`stockout:${bin.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: bin.zoneId,
        binId: bin.id,
        variantId: topRow?.variantId ?? null,
        ownerPoolId: poolByType.get('exception')?.id ?? null,
        sourceType: 'warehouse_bin',
        sourceId: bin.id,
        exceptionType: 'stockout_pressure',
        severity: 'critical',
        status: 'open',
        dueAt,
        slaStatus: computeSlaStatus('open', dueAt, now),
        title: `Stockout pressure at ${bin.code}`,
        description: `${bin.zone.code} has reserved demand without available stock buffer.`,
        sourceStrategy: 'system.materialized',
        externalKey: `stockout:${bin.id}`,
        metadataJson: asJson({
          zoneCode: bin.zone.code,
          qtyReserved,
          qtyAvailable,
        }),
      });
    }

    if (bin.capacityUnits && qtyOnHand > bin.capacityUnits) {
      const dueAt = deriveExceptionDueAt('warning', now);
      desiredExceptions.set(`capacity:${bin.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: bin.zoneId,
        binId: bin.id,
        variantId: topRow?.variantId ?? null,
        ownerPoolId: poolByType.get('exception')?.id ?? null,
        sourceType: 'warehouse_bin',
        sourceId: bin.id,
        exceptionType: 'capacity_overflow',
        severity: 'warning',
        status: 'open',
        dueAt,
        slaStatus: computeSlaStatus('open', dueAt, now),
        title: `Capacity overflow at ${bin.code}`,
        description: `${bin.zone.code} bin is carrying more than its configured unit capacity.`,
        sourceStrategy: 'system.materialized',
        externalKey: `capacity:${bin.id}`,
        metadataJson: asJson({
          zoneCode: bin.zone.code,
          qtyOnHand,
          capacityUnits: bin.capacityUnits,
        }),
      });
    }

    const isPickFace = bin.pickFaceEnabled || bin.binType === 'pick_face' || bin.zone.zoneType === 'picking';
    const replenishCandidate = isPickFace && (
      qtyAvailable <= 0
      || (bin.capacityUnits ? (qtyAvailable / Math.max(bin.capacityUnits, 1)) <= 0.25 : qtyReserved > 0)
    );

    if (replenishCandidate) {
      const fallbackVariant = topRow?.variantId ?? null;
      const reserveSource = balanceRows
        .filter((row) => (
          row.variantId === fallbackVariant
          && row.binId !== bin.id
          && row.qtyAvailable > 0
          && (row.bin.binType === 'reserve' || row.bin.zone.zoneType === 'storage')
        ))
        .sort((left, right) => right.qtyAvailable - left.qtyAvailable)[0];
      const severity = qtyAvailable <= 0 ? 'critical' : 'warning';
      const priority = makeTaskPriority(severity);
      const dueAt = deriveTaskDueAt('replenishment', priority, now);

      desiredTasks.set(`replenishment:${bin.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: bin.zoneId,
        binId: bin.id,
        sourceBinId: reserveSource?.binId ?? null,
        targetBinId: bin.id,
        variantId: fallbackVariant,
        assigneePoolId: poolByType.get('replenishment')?.id ?? null,
        sourceType: 'warehouse_bin',
        sourceId: bin.id,
        taskType: 'replenishment',
        status: 'queued',
        priority,
        dueAt,
        slaStatus: computeSlaStatus('queued', dueAt, now),
        title: makeTaskTitle('replenishment', bin.code),
        description: `${bin.zone.code} pick face is running low and should be refilled.`,
        sourceStrategy: 'system.materialized',
        externalKey: `replenishment:${bin.id}`,
        routeKey: reserveSource ? `${reserveSource.binId}:${bin.id}` : `replenishment:${bin.id}`,
        metadataJson: asJson({
          zoneCode: bin.zone.code,
          sourceBinCode: reserveSource?.bin.code ?? null,
          qtyAvailable,
          qtyReserved,
        }),
      });
    }

    if ((bin.zone.zoneType === 'receiving' || bin.zone.zoneType === 'staging') && qtyOnHand > 0) {
      const targetStorage = bins.find((candidate) => (
        candidate.id !== bin.id
        && candidate.status === 'active'
        && (candidate.binType === 'standard' || candidate.binType === 'reserve' || candidate.zone.zoneType === 'storage')
      ));
      const dueAt = deriveTaskDueAt('putaway', 'normal', now);

      desiredTasks.set(`putaway:${bin.id}`, {
        orgId,
        warehouseSiteId: siteId,
        zoneId: bin.zoneId,
        binId: bin.id,
        sourceBinId: bin.id,
        targetBinId: targetStorage?.id ?? null,
        variantId: topRow?.variantId ?? null,
        assigneePoolId: poolByType.get('putaway')?.id ?? null,
        sourceType: 'warehouse_bin',
        sourceId: bin.id,
        taskType: 'putaway',
        status: 'queued',
        priority: 'normal',
        dueAt,
        slaStatus: computeSlaStatus('queued', dueAt, now),
        title: makeTaskTitle('putaway', bin.code),
        description: `${bin.zone.code} still contains inbound stock waiting for placement.`,
        sourceStrategy: 'system.materialized',
        externalKey: `putaway:${bin.id}`,
        routeKey: targetStorage ? `${bin.id}:${targetStorage.id}` : `putaway:${bin.id}`,
        metadataJson: asJson({
          zoneCode: bin.zone.code,
          qtyOnHand,
          targetBinCode: targetStorage?.code ?? null,
        }),
      });
    }
  }

  for (const reservation of activeReservations) {
    const primaryAllocation = reservation.allocations[0];
    const primaryBin = primaryAllocation?.bin;
    const label = reservation.variant.productCatalog?.name ?? reservation.variant.variantKey;
    const priority = reservation.qtyReserved >= 5 ? 'high' : 'normal';
    const dueAt = deriveTaskDueAt('pick', priority, now);

    desiredTasks.set(`reservation:${reservation.id}`, {
      orgId,
      warehouseSiteId: siteId,
      zoneId: primaryBin?.zoneId ?? null,
      binId: primaryBin?.id ?? null,
      sourceBinId: primaryBin?.id ?? null,
      targetBinId: null,
      variantId: reservation.variantId,
      reservationId: reservation.id,
      assigneePoolId: poolByType.get('pick')?.id ?? null,
      sourceType: reservation.sourceType,
      sourceId: reservation.sourceId,
      sourceLineId: reservation.sourceLineId ?? null,
      taskType: 'pick',
      status: 'queued',
      priority,
      dueAt,
      slaStatus: computeSlaStatus('queued', dueAt, now),
      title: makeTaskTitle('pick', label),
      description: `${reservation.sourceType} requires ${reservation.qtyReserved} units from warehouse stock.`,
      sourceStrategy: 'system.materialized',
      externalKey: `reservation:${reservation.id}`,
      routeKey: primaryBin ? `${primaryBin.id}:dispatch` : `dispatch:${reservation.id}`,
      metadataJson: asJson({
        sourceType: reservation.sourceType,
        sourceId: reservation.sourceId,
        sourceLineId: reservation.sourceLineId,
        sourceBinCode: primaryBin?.code ?? null,
      }),
    });
  }

  const existingTaskMap = new Map(existingTasks.map((task) => [task.externalKey, task]));
  const existingExceptionMap = new Map(existingExceptions.map((item) => [item.externalKey, item]));

  for (const [externalKey, data] of desiredTasks) {
    const current = existingTaskMap.get(externalKey);
    if (!current) {
      const created = await executor.warehouseTask.create({ data });
      if ('warehouseTaskEvent' in executor) {
        await appendTaskEvent(executor as Prisma.TransactionClient, {
          orgId,
          warehouseSiteId: siteId,
          taskId: created.id,
          eventType: 'task.materialized_created',
          payload: {
            externalKey,
            taskType: created.taskType,
            assigneePoolId: created.assigneePoolId,
          },
        });
      }
      continue;
    }

    const preservedStatus = ['assigned', 'accepted', 'in_progress', 'paused'].includes(current.status)
      ? current.status
      : (data.status ?? 'queued');
    const dueAt = data.dueAt instanceof Date ? data.dueAt : null;

    await executor.warehouseTask.update({
      where: { id: current.id },
      data: {
        ...data,
        status: preservedStatus,
        assigneeName: current.assigneeName ?? null,
        assigneeRole: current.assigneeRole ?? null,
        assignedAt: current.assignedAt ?? null,
        assigneePoolId: current.assigneePoolId ?? data.assigneePoolId ?? null,
        startedAt: ['in_progress', 'paused'].includes(preservedStatus) ? (current.startedAt ?? now) : null,
        completedAt: preservedStatus === 'completed' ? (current.completedAt ?? now) : null,
        slaStatus: computeSlaStatus(preservedStatus, dueAt, now),
      },
    });
  }

  for (const task of existingTasks) {
    if (desiredTasks.has(task.externalKey)) continue;

    if (!['completed', 'cancelled'].includes(task.status)) {
      await executor.warehouseTask.update({
        where: { id: task.id },
        data: {
          status: 'cancelled',
          completedAt: now,
          slaStatus: 'closed',
        },
      });
      if ('warehouseTaskEvent' in executor) {
        await appendTaskEvent(executor as Prisma.TransactionClient, {
          orgId,
          warehouseSiteId: siteId,
          taskId: task.id,
          eventType: 'task.materialized_cancelled',
          payload: {
            externalKey: task.externalKey,
          },
        });
      }
    }
  }

  for (const [externalKey, data] of desiredExceptions) {
    const current = existingExceptionMap.get(externalKey);
    if (!current) {
      const created = await executor.warehouseException.create({ data });
      if ('warehouseExceptionEvent' in executor) {
        await appendExceptionEvent(executor as Prisma.TransactionClient, {
          orgId,
          warehouseSiteId: siteId,
          exceptionId: created.id,
          eventType: 'exception.materialized_opened',
          payload: {
            externalKey,
            exceptionType: created.exceptionType,
          },
        });
      }
      continue;
    }

    await executor.warehouseException.update({
      where: { id: current.id },
      data: {
        ...data,
        status: current.status === 'resolved' ? 'open' : current.status,
        ownerName: current.ownerName ?? null,
        ownerRole: current.ownerRole ?? null,
        assignedAt: current.assignedAt ?? null,
        ownerPoolId: current.ownerPoolId ?? data.ownerPoolId ?? null,
        resolvedAt: current.status === 'resolved' ? null : undefined,
        slaStatus: computeSlaStatus(
          current.status === 'resolved' ? 'open' : current.status,
          data.dueAt instanceof Date ? data.dueAt : null,
          now,
        ),
      },
    });
  }

  for (const item of existingExceptions) {
    if (desiredExceptions.has(item.externalKey)) continue;

    if (item.status !== 'resolved') {
      await executor.warehouseException.update({
        where: { id: item.id },
        data: {
          status: 'resolved',
          resolvedAt: now,
          slaStatus: 'closed',
        },
      });
      if ('warehouseExceptionEvent' in executor) {
        await appendExceptionEvent(executor as Prisma.TransactionClient, {
          orgId,
          warehouseSiteId: siteId,
          exceptionId: item.id,
          eventType: 'exception.materialized_closed',
          payload: {
            externalKey: item.externalKey,
          },
        });
      }
    }
  }

  return {
    site,
    assigneePools,
    tasks: {
      materialized: desiredTasks.size,
      active: desiredTasks.size,
    },
    exceptions: {
      materialized: desiredExceptions.size,
      open: desiredExceptions.size,
    },
  };
}

export async function listSiteTasks(orgId: string, siteId: string, filters?: {
  status?: string;
  taskType?: string;
}) {
  await syncWarehouseOperationalState(orgId, siteId);
  const site = await ensureSiteAccess(prisma, orgId, siteId);

  const results = await prisma.warehouseTask.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      status: filters?.status || undefined,
      taskType: filters?.taskType || undefined,
    },
    include: {
      zone: {
        select: { id: true, code: true, name: true },
      },
      bin: {
        select: { id: true, code: true },
      },
      sourceBin: {
        select: { id: true, code: true },
      },
      targetBin: {
        select: { id: true, code: true },
      },
      variant: {
        include: {
          productCatalog: {
            select: { id: true, name: true },
          },
        },
      },
      reservation: {
        select: {
          id: true,
          sourceType: true,
          sourceId: true,
          qtyReserved: true,
          status: true,
        },
      },
      assigneePool: {
        select: {
          id: true,
          code: true,
          name: true,
          poolType: true,
          capacityLimit: true,
        },
      },
    },
    orderBy: [
      { priority: 'desc' },
      { updatedAt: 'desc' },
    ],
  });

  return {
    site,
    count: results.length,
    results,
  };
}

export async function listSiteExceptions(orgId: string, siteId: string, filters?: {
  status?: string;
  severity?: string;
}) {
  await syncWarehouseOperationalState(orgId, siteId);
  const site = await ensureSiteAccess(prisma, orgId, siteId);

  const results = await prisma.warehouseException.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      status: filters?.status || undefined,
      severity: filters?.severity || undefined,
    },
    include: {
      zone: {
        select: { id: true, code: true, name: true },
      },
      bin: {
        select: { id: true, code: true },
      },
      task: {
        select: { id: true, title: true, taskType: true, status: true },
      },
      variant: {
        include: {
          productCatalog: {
            select: { id: true, name: true },
          },
        },
      },
      ownerPool: {
        select: {
          id: true,
          code: true,
          name: true,
          poolType: true,
          capacityLimit: true,
        },
      },
    },
    orderBy: [
      { severity: 'desc' },
      { updatedAt: 'desc' },
    ],
  });

  return {
    site,
    count: results.length,
    results,
  };
}

export async function listAssigneePools(orgId: string, siteId: string) {
  await ensureSiteAccess(prisma, orgId, siteId);
  await ensureAssigneePools(prisma, orgId, siteId);

  const [pools, tasks, exceptions] = await Promise.all([
    prisma.warehouseAssigneePool.findMany({
      where: { orgId, warehouseSiteId: siteId, active: true },
      orderBy: [{ poolType: 'asc' }, { code: 'asc' }],
    }),
    prisma.warehouseTask.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: { notIn: ['completed', 'cancelled'] },
      },
      select: {
        id: true,
        assigneePoolId: true,
        status: true,
        slaStatus: true,
      },
    }),
    prisma.warehouseException.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: { not: 'resolved' },
      },
      select: {
        id: true,
        ownerPoolId: true,
        slaStatus: true,
      },
    }),
  ]);

  return {
    count: pools.length,
    results: pools.map((pool) => {
      const poolTasks = tasks.filter((task) => task.assigneePoolId === pool.id);
      const poolExceptions = exceptions.filter((item) => item.ownerPoolId === pool.id);
      return {
        ...pool,
        activeTasks: poolTasks.length,
        overdueTasks: poolTasks.filter((task) => task.slaStatus === 'breached').length,
        activeExceptions: poolExceptions.length,
        breachedExceptions: poolExceptions.filter((item) => item.slaStatus === 'breached').length,
      };
    }),
  };
}

export async function getTaskTimeline(orgId: string, taskId: string) {
  const task = await prisma.warehouseTask.findFirst({
    where: { id: taskId, orgId },
    include: {
      assigneePool: {
        select: { id: true, code: true, name: true, poolType: true, capacityLimit: true },
      },
      sourceBin: { select: { id: true, code: true } },
      targetBin: { select: { id: true, code: true } },
      variant: {
        include: {
          productCatalog: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!task) {
    throw new AppError(404, 'Warehouse task not found', 'NOT_FOUND');
  }

  const events = await prisma.warehouseTaskEvent.findMany({
    where: { orgId, taskId: task.id },
    orderBy: [{ createdAt: 'asc' }],
  });

  return {
    task,
    count: events.length,
    results: events,
  };
}

export async function getExceptionTimeline(orgId: string, exceptionId: string) {
  const item = await prisma.warehouseException.findFirst({
    where: { id: exceptionId, orgId },
    include: {
      ownerPool: {
        select: { id: true, code: true, name: true, poolType: true, capacityLimit: true },
      },
      task: {
        select: { id: true, title: true, taskType: true, status: true },
      },
      bin: { select: { id: true, code: true } },
      zone: { select: { id: true, code: true, name: true } },
    },
  });

  if (!item) {
    throw new AppError(404, 'Warehouse exception not found', 'NOT_FOUND');
  }

  const events = await prisma.warehouseExceptionEvent.findMany({
    where: { orgId, exceptionId: item.id },
    orderBy: [{ createdAt: 'asc' }],
  });

  return {
    exception: item,
    count: events.length,
    results: events,
  };
}

function mapStatusToTaskCommand(status: string) {
  if (status === 'assigned') return 'assign';
  if (status === 'accepted' || status === 'in_progress') return 'start';
  if (status === 'paused') return 'pause';
  if (status === 'completed') return 'complete';
  if (status === 'cancelled') return 'cancel';
  return null;
}

function nextTaskStatusFromCommand(currentStatus: string, command: string) {
  if (command === 'assign') {
    if (['completed', 'cancelled'].includes(currentStatus)) {
      throw new AppError(409, 'Completed task cannot be reassigned', 'CONFLICT');
    }
    return 'assigned';
  }

  if (command === 'start') {
    if (!['queued', 'assigned', 'accepted', 'paused'].includes(currentStatus)) {
      throw new AppError(409, 'Task cannot be started from current state', 'CONFLICT');
    }
    return 'in_progress';
  }

  if (command === 'pause') {
    if (currentStatus !== 'in_progress') {
      throw new AppError(409, 'Only in-progress tasks can be paused', 'CONFLICT');
    }
    return 'paused';
  }

  if (command === 'complete') {
    if (!['assigned', 'accepted', 'in_progress', 'paused'].includes(currentStatus)) {
      throw new AppError(409, 'Task cannot be completed from current state', 'CONFLICT');
    }
    return 'completed';
  }

  if (command === 'cancel') {
    if (['completed', 'cancelled'].includes(currentStatus)) {
      throw new AppError(409, 'Task is already closed', 'CONFLICT');
    }
    return 'cancelled';
  }

  throw new AppError(400, 'Unsupported task command', 'VALIDATION');
}

export async function commandTask(orgId: string, taskId: string, input: {
  command: 'assign' | 'start' | 'pause' | 'complete' | 'cancel' | 'replenish';
  assigneeName?: string | null;
  assigneeRole?: string | null;
  poolId?: string | null;
  actorName?: string | null;
}) {
  const task = await prisma.warehouseTask.findFirst({
    where: { id: taskId, orgId },
  });

  if (!task) {
    throw new AppError(404, 'Warehouse task not found', 'NOT_FOUND');
  }

  if (input.command === 'replenish') {
    if (task.taskType !== 'replenishment') {
      throw new AppError(409, 'Only replenishment tasks can execute replenishment transfer', 'CONFLICT');
    }
    if (!task.sourceBinId || !task.targetBinId || !task.variantId) {
      throw new AppError(409, 'Replenishment task is missing route or variant data', 'CONFLICT');
    }

    await postStockTransfer(orgId, {
      warehouseSiteId: task.warehouseSiteId,
      variantId: task.variantId,
      fromBinId: task.sourceBinId,
      toBinId: task.targetBinId,
      qty: Math.max(1, toFiniteNumber(asRecord(task.metadataJson).qtyReserved, 0) || 1),
      sourceType: 'warehouse_task',
      sourceId: task.id,
      sourceLineId: task.targetBinId,
      idempotencyKey: `warehouse-task-replenish:${task.id}`,
      actorName: input.actorName ?? input.assigneeName ?? task.assigneeName ?? 'Warehouse Twin',
      reason: 'replenishment task executed from warehouse twin',
    });

    return prisma.$transaction(async (tx) => {
      const updated = await tx.warehouseTask.update({
        where: { id: task.id },
        data: {
          status: 'completed',
          assigneeName: input.assigneeName ?? task.assigneeName ?? input.actorName ?? 'Warehouse Twin',
          assigneeRole: input.assigneeRole ?? task.assigneeRole ?? 'operator',
          assigneePoolId: input.poolId ?? task.assigneePoolId ?? null,
          assignedAt: task.assignedAt ?? new Date(),
          startedAt: task.startedAt ?? new Date(),
          completedAt: new Date(),
          slaStatus: 'closed',
        },
      });

      await createOutboxRecord(tx, {
        orgId,
        warehouseSiteId: task.warehouseSiteId,
        aggregateType: 'warehouse.task',
        aggregateId: task.id,
        eventType: 'warehouse.task.replenishment_executed',
        payload: {
          taskId: task.id,
          warehouseSiteId: task.warehouseSiteId,
          sourceBinId: task.sourceBinId,
          targetBinId: task.targetBinId,
          variantId: task.variantId,
        },
      });

      await appendTaskEvent(tx, {
        orgId,
        warehouseSiteId: task.warehouseSiteId,
        taskId: task.id,
        eventType: 'task.replenish',
        actorName: input.actorName ?? input.assigneeName ?? task.assigneeName ?? 'Warehouse Twin',
        payload: {
          sourceBinId: task.sourceBinId,
          targetBinId: task.targetBinId,
          variantId: task.variantId,
        },
      });

      return updated;
    });
  }

  const nextStatus = nextTaskStatusFromCommand(task.status, input.command);
  const now = new Date();
  const assigneeName = input.assigneeName?.trim() || task.assigneeName || input.actorName?.trim() || null;
  const assigneeRole = input.assigneeRole?.trim() || task.assigneeRole || null;
  const assigneePoolId = input.poolId ?? task.assigneePoolId ?? null;

  return prisma.$transaction(async (tx) => {
    const updated = await tx.warehouseTask.update({
      where: { id: task.id },
      data: {
        status: nextStatus,
        assigneeName,
        assigneeRole,
        assigneePoolId,
        assignedAt: input.command === 'assign' || input.command === 'start'
          ? (task.assignedAt ?? now)
          : task.assignedAt,
        startedAt: input.command === 'start'
          ? (task.startedAt ?? now)
          : (nextStatus === 'cancelled' ? null : task.startedAt),
        completedAt: ['completed', 'cancelled'].includes(nextStatus) ? now : null,
        slaStatus: computeSlaStatus(nextStatus, task.dueAt, now),
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: task.warehouseSiteId,
      aggregateType: 'warehouse.task',
      aggregateId: task.id,
      eventType: 'warehouse.task.command_executed',
      payload: {
        taskId: task.id,
        warehouseSiteId: task.warehouseSiteId,
        command: input.command,
        status: nextStatus,
        assigneeName,
        assigneeRole,
        assigneePoolId,
      },
    });

    await appendTaskEvent(tx, {
      orgId,
      warehouseSiteId: task.warehouseSiteId,
      taskId: task.id,
      eventType: `task.${input.command}`,
      actorName: input.actorName ?? assigneeName,
      payload: {
        status: nextStatus,
        assigneeName,
        assigneeRole,
        assigneePoolId,
      },
    });

    return updated;
  });
}

function nextExceptionStatusFromCommand(currentStatus: string, command: string) {
  if (command === 'assign') {
    if (currentStatus === 'resolved') {
      throw new AppError(409, 'Resolved exception cannot be assigned', 'CONFLICT');
    }
    return 'assigned';
  }

  if (command === 'acknowledge') {
    if (currentStatus === 'resolved') {
      throw new AppError(409, 'Resolved exception cannot be acknowledged', 'CONFLICT');
    }
    return 'acknowledged';
  }

  if (command === 'escalate') {
    if (currentStatus === 'resolved') {
      throw new AppError(409, 'Resolved exception cannot be escalated', 'CONFLICT');
    }
    return 'escalated';
  }

  if (command === 'resolve') {
    return 'resolved';
  }

  if (command === 'reopen') {
    return 'open';
  }

  throw new AppError(400, 'Unsupported exception command', 'VALIDATION');
}

export async function commandException(orgId: string, exceptionId: string, input: {
  command: 'assign' | 'acknowledge' | 'resolve' | 'escalate' | 'reopen';
  ownerName?: string | null;
  ownerRole?: string | null;
  poolId?: string | null;
  resolutionCode?: string | null;
  actorName?: string | null;
}) {
  const item = await prisma.warehouseException.findFirst({
    where: { id: exceptionId, orgId },
  });

  if (!item) {
    throw new AppError(404, 'Warehouse exception not found', 'NOT_FOUND');
  }

  const nextStatus = nextExceptionStatusFromCommand(item.status, input.command);
  const now = new Date();
  const ownerName = input.ownerName?.trim() || item.ownerName || input.actorName?.trim() || null;
  const ownerRole = input.ownerRole?.trim() || item.ownerRole || null;
  const ownerPoolId = input.poolId ?? item.ownerPoolId ?? null;
  const dueAt = item.dueAt ?? deriveExceptionDueAt(item.severity, now);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.warehouseException.update({
      where: { id: item.id },
      data: {
        status: nextStatus,
        ownerName,
        ownerRole,
        ownerPoolId,
        assignedAt: ['assign', 'acknowledge', 'escalate'].includes(input.command)
          ? (item.assignedAt ?? now)
          : item.assignedAt,
        dueAt,
        resolutionCode: input.command === 'resolve'
          ? (input.resolutionCode?.trim() || item.resolutionCode || 'resolved_from_twin')
          : (input.command === 'reopen' ? null : item.resolutionCode),
        resolvedAt: nextStatus === 'resolved' ? now : null,
        slaStatus: computeSlaStatus(nextStatus, dueAt, now),
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: item.warehouseSiteId,
      aggregateType: 'warehouse.exception',
      aggregateId: item.id,
      eventType: 'warehouse.exception.command_executed',
      payload: {
        exceptionId: item.id,
        warehouseSiteId: item.warehouseSiteId,
        command: input.command,
        status: nextStatus,
        ownerName,
        ownerRole,
        ownerPoolId,
        resolutionCode: updated.resolutionCode,
      },
    });

    await appendExceptionEvent(tx, {
      orgId,
      warehouseSiteId: item.warehouseSiteId,
      exceptionId: item.id,
      eventType: `exception.${input.command}`,
      actorName: input.actorName ?? ownerName,
      payload: {
        status: nextStatus,
        ownerName,
        ownerRole,
        ownerPoolId,
        resolutionCode: updated.resolutionCode,
      },
    });

    return updated;
  });
}

export async function updateTaskStatus(orgId: string, taskId: string, input: {
  status: string;
  actorName?: string | null;
}) {
  const command = mapStatusToTaskCommand(input.status);
  if (!command) {
    throw new AppError(400, 'Unsupported warehouse task status update', 'VALIDATION');
  }
  return commandTask(orgId, taskId, {
    command,
    actorName: input.actorName,
  });
}

export async function updateExceptionStatus(orgId: string, exceptionId: string, input: {
  status: string;
  actorName?: string | null;
}) {
  const command = input.status === 'resolved'
    ? 'resolve'
    : input.status === 'acknowledged'
      ? 'acknowledge'
      : input.status === 'assigned'
        ? 'assign'
        : input.status === 'escalated'
          ? 'escalate'
          : input.status === 'open'
            ? 'reopen'
            : null;

  if (!command) {
    throw new AppError(400, 'Unsupported warehouse exception status update', 'VALIDATION');
  }

  return commandException(orgId, exceptionId, {
    command,
    actorName: input.actorName,
  });
}

async function buildLayoutDraftAnalysis(tx: Tx, orgId: string, draftId: string, persist = false) {
  const draft = await tx.warehouseLayoutVersion.findFirst({
    where: {
      id: draftId,
      orgId,
    },
    include: {
      site: {
        select: {
          id: true,
          code: true,
          name: true,
          publishedLayoutVersionId: true,
        },
      },
      basedOnVersion: {
        select: {
          id: true,
          versionNo: true,
        },
      },
    },
  });

  if (!draft) {
    throw new AppError(404, 'Draft layout not found', 'NOT_FOUND');
  }

  const baseLayoutVersionId = draft.basedOnVersionId ?? draft.site.publishedLayoutVersionId;
  if (!baseLayoutVersionId) {
    throw new AppError(409, 'Draft layout has no base version to compare against', 'CONFLICT');
  }

  const [draftNodes, baseNodes, activeTasks, stockBalances] = await Promise.all([
    tx.warehouseLayoutNode.findMany({
      where: { orgId, warehouseSiteId: draft.warehouseSiteId, layoutVersionId: draft.id },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
      include: {
        zone: { select: { id: true, code: true, name: true, zoneType: true } },
        bin: { select: { id: true, code: true, binType: true, pickFaceEnabled: true } },
      },
    }),
    tx.warehouseLayoutNode.findMany({
      where: { orgId, warehouseSiteId: draft.warehouseSiteId, layoutVersionId: baseLayoutVersionId },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
    }),
    tx.warehouseTask.findMany({
      where: {
        orgId,
        warehouseSiteId: draft.warehouseSiteId,
        status: { notIn: ['completed', 'cancelled'] },
      },
      include: {
        zone: { select: { id: true, code: true, name: true } },
        bin: { select: { id: true, code: true } },
        sourceBin: { select: { id: true, code: true } },
        targetBin: { select: { id: true, code: true } },
      },
    }),
    tx.warehouseStockBalance.findMany({
      where: {
        orgId,
        warehouseSiteId: draft.warehouseSiteId,
        OR: [
          { qtyOnHand: { gt: 0 } },
          { qtyReserved: { gt: 0 } },
        ],
      },
      include: {
        bin: { select: { id: true, code: true, zoneId: true } },
      },
    }),
  ]);

  const baseNodeMap = new Map(baseNodes.map((node) => [`${node.domainType}:${node.domainId}`, node]));
  const stockByBinId = new Map<string, number>();
  for (const row of stockBalances) {
    stockByBinId.set(row.binId, (stockByBinId.get(row.binId) ?? 0) + row.qtyOnHand + row.qtyReserved);
  }

  const changedDomainKeys = new Set<string>();
  const hiddenDomainKeys = new Set<string>();
  const impactedBinIds = new Set<string>();
  const hardBlockers: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  const changedNodes: Array<Record<string, unknown>> = [];

  const createdNodes = draftNodes.filter((node) => !baseNodeMap.has(`${node.domainType}:${node.domainId}`));
  let movedNodes = 0;
  let resizedNodes = 0;
  let hiddenNodes = 0;

  for (const node of draftNodes) {
    const key = `${node.domainType}:${node.domainId}`;
    const baseNode = baseNodeMap.get(key);
    if (!baseNode) {
      changedDomainKeys.add(key);
      changedNodes.push({
        domainType: node.domainType,
        domainId: node.domainId,
        changeType: 'created',
        label: node.label,
      });
      continue;
    }

    const moveDistance = Math.hypot(node.x - baseNode.x, node.y - baseNode.y);
    const resized = (
      Math.abs(node.width - baseNode.width) > 0.01
      || Math.abs(node.height - baseNode.height) > 0.01
      || Math.abs(node.rotation - baseNode.rotation) > 0.01
    );
    const hiddenChanged = node.hidden !== baseNode.hidden;

    if (moveDistance > 0.05 || resized || hiddenChanged) {
      changedDomainKeys.add(key);
      if (moveDistance > 0.05) movedNodes += 1;
      if (resized) resizedNodes += 1;
      if (hiddenChanged && node.hidden) {
        hiddenNodes += 1;
        hiddenDomainKeys.add(key);
      }

      changedNodes.push({
        domainType: node.domainType,
        domainId: node.domainId,
        changeType: hiddenChanged && node.hidden
          ? 'hidden'
          : resized
            ? 'resized'
            : 'moved',
        label: node.label,
        moveDistance: Number(moveDistance.toFixed(2)),
      });
    }

    if (node.nodeType === 'zone' && (node.width < 3 || node.height < 2.4)) {
      hardBlockers.push({
        code: 'layout.zone_size_invalid',
        severity: 'critical',
        nodeId: node.id,
        domainType: node.domainType,
        domainId: node.domainId,
        message: `Zone ${node.label ?? node.domainId} is too small for readable operational layout.`,
      });
    }

    if (node.nodeType === 'bin' && (node.width < 0.55 || node.height < 0.42)) {
      hardBlockers.push({
        code: 'layout.bin_size_invalid',
        severity: 'critical',
        nodeId: node.id,
        domainType: node.domainType,
        domainId: node.domainId,
        message: `Bin ${node.label ?? node.domainId} is below minimum footprint.`,
      });
    }

    if (node.domainType === 'warehouse.bin' && stockByBinId.get(node.domainId) && node.hidden) {
      impactedBinIds.add(node.domainId);
      hardBlockers.push({
        code: 'layout.occupied_bin_hidden',
        severity: 'critical',
        nodeId: node.id,
        domainType: node.domainType,
        domainId: node.domainId,
        message: `Bin ${node.label ?? node.domainId} cannot be hidden while it still carries stock or reservations.`,
      });
    }
  }

  const visibleNodes = draftNodes.filter((node) => !node.hidden);
  for (let index = 0; index < visibleNodes.length; index += 1) {
    for (let inner = index + 1; inner < visibleNodes.length; inner += 1) {
      const left = visibleNodes[index];
      const right = visibleNodes[inner];
      if (!left || !right) continue;
      if (left.nodeType !== right.nodeType) continue;
      const comparableLayer = left.nodeType === 'zone'
        ? true
        : Boolean(left.parentNodeId && left.parentNodeId === right.parentNodeId);
      if (comparableLayer && rectsOverlap(left, right)) {
        hardBlockers.push({
          code: 'layout.node_collision',
          severity: 'critical',
          nodeId: left.id,
          relatedNodeId: right.id,
          message: `${left.label ?? left.domainId} collides with ${right.label ?? right.domainId}.`,
        });
      }
    }
  }

  const taskImpactMatrix = activeTasks
    .map((task) => {
      const impacted = Boolean(
        (task.binId && changedDomainKeys.has(`warehouse.bin:${task.binId}`))
        || (task.sourceBinId && changedDomainKeys.has(`warehouse.bin:${task.sourceBinId}`))
        || (task.targetBinId && changedDomainKeys.has(`warehouse.bin:${task.targetBinId}`))
        || (task.zoneId && changedDomainKeys.has(`warehouse.zone:${task.zoneId}`))
      );

      if (!impacted) {
        return null;
      }

      if (task.sourceBinId) impactedBinIds.add(task.sourceBinId);
      if (task.targetBinId) impactedBinIds.add(task.targetBinId);

      const impactLevel = ['in_progress', 'paused'].includes(task.status)
        ? 'hard_blocker'
        : ['assigned', 'accepted'].includes(task.status)
          ? 'review_required'
          : 'review_required';

      if (impactLevel === 'hard_blocker') {
        hardBlockers.push({
          code: 'layout.active_task_impacted',
          severity: 'critical',
          taskId: task.id,
          message: `${task.title} is ${task.status} and its active route is impacted by the draft layout.`,
        });
      } else {
        warnings.push({
          code: 'layout.task_replan_required',
          severity: 'warning',
          taskId: task.id,
          message: `${task.title} should be replanned after publish.`,
        });
      }

      return {
        taskId: task.id,
        taskType: task.taskType,
        title: task.title,
        status: task.status,
        impactLevel,
        action: impactLevel === 'hard_blocker'
          ? 'pause_or_complete_before_publish'
          : 'supervisor_reassign_or_recompute',
        sourceBinId: task.sourceBinId,
        sourceBinCode: task.sourceBin?.code ?? null,
        targetBinId: task.targetBinId,
        targetBinCode: task.targetBin?.code ?? null,
      };
    })
    .filter(Boolean);

  const impactSummary = {
    hardBlockers: taskImpactMatrix.filter((row) => row?.impactLevel === 'hard_blocker').length,
    reviewRequired: taskImpactMatrix.filter((row) => row?.impactLevel === 'review_required').length,
    impactedBins: Array.from(impactedBinIds),
  };

  const summary = {
    createdNodes: createdNodes.length,
    movedNodes,
    resizedNodes,
    hiddenNodes,
    hardBlockers: hardBlockers.length,
    warnings: warnings.length,
    impactedTasks: taskImpactMatrix.length,
  };
  const publishPolicy = buildPublishPolicy({
    hardBlockers,
    warnings,
    taskImpactMatrix: taskImpactMatrix as Array<Record<string, unknown>>,
  });

  const analysis = {
    draft: {
      id: draft.id,
      warehouseSiteId: draft.warehouseSiteId,
      versionNo: draft.versionNo,
      state: draft.state,
      validationStatus: hardBlockers.length > 0 ? 'blocked' : (warnings.length > 0 ? 'warning' : 'valid'),
      validatedAt: new Date().toISOString(),
    },
    publishReady: publishPolicy.canPublish,
    publishPolicy,
    summary,
    diff: {
      createdNodes: createdNodes.length,
      movedNodes,
      resizedNodes,
      hiddenNodes,
      changedNodes: changedNodes.slice(0, 24),
    },
    hardBlockers,
    warnings,
    taskImpactMatrix,
    conflictSheet: {
      impactedTaskCount: taskImpactMatrix.length,
      hardBlockerCount: impactSummary.hardBlockers,
      reviewRequiredCount: impactSummary.reviewRequired,
      impactedBinIds: impactSummary.impactedBins,
    },
  };

  if (persist) {
    await tx.warehouseLayoutVersion.update({
      where: { id: draft.id },
      data: {
        validationStatus: analysis.draft.validationStatus,
        validationSummaryJson: analysis as Prisma.InputJsonValue,
        validatedAt: new Date(),
      },
    });
  }

  return analysis;
}

export async function validateLayoutDraft(orgId: string, draftId: string) {
  return prisma.$transaction((tx) => buildLayoutDraftAnalysis(tx, orgId, draftId, true));
}

export async function createLayoutDraft(orgId: string, siteId: string, actorName?: string | null, notes?: string | null) {
  return prisma.$transaction(async (tx) => {
    const site = await ensureSiteAccess(tx, orgId, siteId);
    const live = await resolveLiveLayoutVersion(tx, orgId, siteId);
    await bootstrapLayoutNodesForVersion(tx, { orgId, siteId, layoutVersionId: live.id });

    const latestVersion = await tx.warehouseLayoutVersion.findFirst({
      where: { orgId, warehouseSiteId: siteId },
      orderBy: { versionNo: 'desc' },
      select: { versionNo: true },
    });

    const draft = await tx.warehouseLayoutVersion.create({
      data: {
        orgId,
        warehouseSiteId: siteId,
        versionNo: (latestVersion?.versionNo ?? 0) + 1,
        state: 'draft',
        basedOnVersionId: live.id,
        createdBy: actorName?.trim() || 'system',
        notes: normalizeNotes(notes) ?? `Draft based on ${live.versionNo}`,
      },
    });

    const liveNodes = await tx.warehouseLayoutNode.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        layoutVersionId: live.id,
      },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
    });

    if (liveNodes.length > 0) {
      const idMap = new Map<string, string>();
      for (const node of liveNodes) {
        idMap.set(node.id, randomUUID());
      }

      await tx.warehouseLayoutNode.createMany({
        data: liveNodes.map((node) => ({
          id: idMap.get(node.id)!,
          orgId,
          warehouseSiteId: siteId,
          layoutVersionId: draft.id,
          zoneId: node.zoneId,
          binId: node.binId,
          parentNodeId: node.parentNodeId ? idMap.get(node.parentNodeId) ?? null : null,
          nodeType: node.nodeType,
          domainType: node.domainType,
          domainId: node.domainId,
          label: node.label,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.rotation,
          zIndex: node.zIndex,
          hidden: node.hidden,
          metadataJson: node.metadataJson === null ? Prisma.JsonNull : (node.metadataJson as Prisma.InputJsonValue | undefined),
        })),
      });
    }

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: siteId,
      aggregateType: 'warehouse.layout',
      aggregateId: draft.id,
      eventType: 'warehouse.layout.draft_created',
      payload: {
        draftId: draft.id,
        siteId,
        basedOnVersionId: live.id,
      },
    });

    return {
      site,
      draft,
      basedOn: live,
    };
  });
}

export async function updateLayoutDraftNode(orgId: string, draftId: string, nodeId: string, input: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  hidden?: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.warehouseLayoutVersion.findFirst({
      where: {
        id: draftId,
        orgId,
      },
    });

    if (!draft || draft.state !== 'draft') {
      throw new AppError(404, 'Draft layout not found', 'NOT_FOUND');
    }

    const node = await tx.warehouseLayoutNode.findFirst({
      where: {
        id: nodeId,
        orgId,
        layoutVersionId: draftId,
      },
    });

    if (!node) {
      throw new AppError(404, 'Layout node not found', 'NOT_FOUND');
    }

    const updated = await tx.warehouseLayoutNode.update({
      where: { id: node.id },
      data: {
        x: input.x ?? node.x,
        y: input.y ?? node.y,
        width: input.width ?? node.width,
        height: input.height ?? node.height,
        rotation: input.rotation ?? node.rotation,
        hidden: input.hidden ?? node.hidden,
      },
    });

    await tx.warehouseLayoutVersion.update({
      where: { id: draftId },
      data: {
        validationStatus: 'stale',
        validationSummaryJson: Prisma.JsonNull,
        validatedAt: null,
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: draft.warehouseSiteId,
      aggregateType: 'warehouse.layout_node',
      aggregateId: updated.id,
      eventType: 'warehouse.layout.node_updated',
      payload: {
        draftId,
        nodeId: updated.id,
        x: updated.x,
        y: updated.y,
        width: updated.width,
        height: updated.height,
        rotation: updated.rotation,
        hidden: updated.hidden,
      },
    });

    return updated;
  });
}

export async function publishLayoutDraft(orgId: string, draftId: string, input?: {
  force?: boolean;
  forceReason?: string | null;
  actorName?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const draft = await tx.warehouseLayoutVersion.findFirst({
      where: {
        id: draftId,
        orgId,
      },
    });

    if (!draft || draft.state !== 'draft') {
      throw new AppError(404, 'Draft layout not found', 'NOT_FOUND');
    }

    const analysis = await buildLayoutDraftAnalysis(tx, orgId, draft.id, true);
    const forceRequested = Boolean(input?.force);
    if (!analysis.publishReady && !(forceRequested && analysis.publishPolicy?.canForcePublish)) {
      throw new AppError(409, 'Layout publish is blocked by active conflicts or validation blockers', 'CONFLICT');
    }

    if (forceRequested && analysis.publishPolicy?.canForcePublish) {
      const impactedTaskIds = analysis.taskImpactMatrix
        .filter((row): row is NonNullable<typeof row> => row != null && row.impactLevel === 'hard_blocker')
        .map((row) => row.taskId);

      if (impactedTaskIds.length > 0) {
        const now = new Date();
        const tasksToPause = await tx.warehouseTask.findMany({
          where: {
            id: { in: impactedTaskIds },
            orgId,
            warehouseSiteId: draft.warehouseSiteId,
            status: { in: ['assigned', 'accepted', 'in_progress', 'paused'] },
          },
        });

        for (const task of tasksToPause) {
          await tx.warehouseTask.update({
            where: { id: task.id },
            data: {
              status: 'paused',
              assigneeName: task.assigneeName ?? input?.actorName?.trim() ?? 'Warehouse Supervisor',
              assignedAt: task.assignedAt ?? now,
              startedAt: task.startedAt ?? now,
              slaStatus: computeSlaStatus('paused', task.dueAt, now),
              metadataJson: {
                ...asRecord(task.metadataJson),
                publishForceReason: normalizeNotes(input?.forceReason) ?? null,
                publishForceAt: now.toISOString(),
              } as Prisma.InputJsonValue,
            },
          });

          await appendTaskEvent(tx, {
            orgId,
            warehouseSiteId: task.warehouseSiteId,
            taskId: task.id,
            eventType: 'task.publish_force_paused',
            actorName: input?.actorName?.trim() || 'Warehouse Supervisor',
            payload: {
              draftId: draft.id,
              forceReason: normalizeNotes(input?.forceReason),
            },
          });
        }
      }
    }

    await tx.warehouseLayoutVersion.updateMany({
      where: {
        orgId,
        warehouseSiteId: draft.warehouseSiteId,
        id: { not: draft.id },
        state: 'published',
      },
      data: {
        state: 'archived',
      },
    });

    const published = await tx.warehouseLayoutVersion.update({
      where: { id: draft.id },
      data: {
        state: 'published',
        publishedAt: new Date(),
      },
    });

    await tx.warehouseSite.update({
      where: { id: draft.warehouseSiteId },
      data: {
        publishedLayoutVersionId: draft.id,
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: draft.warehouseSiteId,
      aggregateType: 'warehouse.layout',
      aggregateId: published.id,
      eventType: 'warehouse.layout.published',
      payload: {
        layoutVersionId: published.id,
        warehouseSiteId: draft.warehouseSiteId,
        forcePublished: forceRequested,
        forceReason: normalizeNotes(input?.forceReason),
        blockedBy: analysis.publishPolicy?.blockedBy ?? [],
      },
    });

    await tx.warehouseLayoutPublishAudit.create({
      data: {
        orgId,
        warehouseSiteId: draft.warehouseSiteId,
        layoutVersionId: published.id,
        action: forceRequested ? 'force_publish' : 'publish',
        actorName: input?.actorName?.trim() || 'Warehouse Supervisor',
        forceReason: normalizeNotes(input?.forceReason),
        previousVersionId: draft.basedOnVersionId ?? null,
        blockerSummaryJson: forceRequested && analysis.publishPolicy?.blockedBy?.length
          ? ({ blockedBy: analysis.publishPolicy.blockedBy } as Prisma.InputJsonValue)
          : undefined,
        impactedTaskCount: analysis.taskImpactMatrix?.length ?? 0,
      },
    });

    return published;
  });
}

export async function compareLayoutVersions(orgId: string, leftVersionId: string, rightVersionId: string) {
  const [leftVersion, rightVersion] = await Promise.all([
    prisma.warehouseLayoutVersion.findFirst({
      where: { id: leftVersionId, orgId },
    }),
    prisma.warehouseLayoutVersion.findFirst({
      where: { id: rightVersionId, orgId },
    }),
  ]);

  if (!leftVersion || !rightVersion) {
    throw new AppError(404, 'Layout version compare target not found', 'NOT_FOUND');
  }

  if (leftVersion.warehouseSiteId !== rightVersion.warehouseSiteId) {
    throw new AppError(409, 'Cannot compare layout versions from different sites', 'CONFLICT');
  }

  const [leftNodes, rightNodes] = await Promise.all([
    prisma.warehouseLayoutNode.findMany({
      where: { orgId, warehouseSiteId: leftVersion.warehouseSiteId, layoutVersionId: leftVersion.id },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.warehouseLayoutNode.findMany({
      where: { orgId, warehouseSiteId: rightVersion.warehouseSiteId, layoutVersionId: rightVersion.id },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
    }),
  ]);

  const leftByKey = new Map(leftNodes.map((node) => [`${node.domainType}:${node.domainId}`, node]));
  const rightByKey = new Map(rightNodes.map((node) => [`${node.domainType}:${node.domainId}`, node]));
  const allKeys = Array.from(new Set([...leftByKey.keys(), ...rightByKey.keys()]));

  let createdNodes = 0;
  let removedNodes = 0;
  let movedNodes = 0;
  let resizedNodes = 0;
  let hiddenChangedNodes = 0;
  const changedNodes: Array<Record<string, unknown>> = [];

  for (const key of allKeys) {
    const leftNode = leftByKey.get(key);
    const rightNode = rightByKey.get(key);

    if (!leftNode && rightNode) {
      createdNodes += 1;
      changedNodes.push({
        domainType: rightNode.domainType,
        domainId: rightNode.domainId,
        changeType: 'created',
        label: rightNode.label,
      });
      continue;
    }

    if (leftNode && !rightNode) {
      removedNodes += 1;
      changedNodes.push({
        domainType: leftNode.domainType,
        domainId: leftNode.domainId,
        changeType: 'removed',
        label: leftNode.label,
      });
      continue;
    }

    if (!leftNode || !rightNode) {
      continue;
    }

    const moveDistance = Math.hypot(rightNode.x - leftNode.x, rightNode.y - leftNode.y);
    const resized = (
      Math.abs(rightNode.width - leftNode.width) > 0.01
      || Math.abs(rightNode.height - leftNode.height) > 0.01
      || Math.abs(rightNode.rotation - leftNode.rotation) > 0.01
    );
    const hiddenChanged = rightNode.hidden !== leftNode.hidden;

    if (moveDistance > 0.05) movedNodes += 1;
    if (resized) resizedNodes += 1;
    if (hiddenChanged) hiddenChangedNodes += 1;

    if (moveDistance > 0.05 || resized || hiddenChanged) {
      changedNodes.push({
        domainType: rightNode.domainType,
        domainId: rightNode.domainId,
        changeType: hiddenChanged
          ? 'visibility'
          : resized
            ? 'resized'
            : 'moved',
        label: rightNode.label,
        moveDistance: Number(moveDistance.toFixed(2)),
      });
    }
  }

  return {
    leftVersion,
    rightVersion,
    summary: {
      createdNodes,
      removedNodes,
      movedNodes,
      resizedNodes,
      hiddenChangedNodes,
      changedNodes: changedNodes.length,
    },
    changedNodes: changedNodes.slice(0, 48),
  };
}

function nodeCenter(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return {
    x: node.x + (node.width / 2),
    y: node.y + (node.height / 2),
  };
}

export async function getWarehouseTwinRuntime(orgId: string, siteId: string, input?: {
  draftVersionId?: string;
}) {
  await syncWarehouseOperationalState(orgId, siteId);
  const liveLayout = await ensureLiveLayoutNodes(orgId, siteId);

  const [site, availableDrafts, historyVersions, selectedDraft, assigneePools] = await Promise.all([
    ensureSiteAccess(prisma, orgId, siteId),
    prisma.warehouseLayoutVersion.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        state: 'draft',
      },
      orderBy: [{ updatedAt: 'desc' }],
    }),
    prisma.warehouseLayoutVersion.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        state: { in: ['published', 'archived'] },
      },
      orderBy: [{ versionNo: 'desc' }],
      take: 6,
    }),
    input?.draftVersionId
      ? prisma.warehouseLayoutVersion.findFirst({
        where: {
          id: input.draftVersionId,
          orgId,
          warehouseSiteId: siteId,
          state: 'draft',
        },
      })
      : prisma.warehouseLayoutVersion.findFirst({
        where: {
          orgId,
          warehouseSiteId: siteId,
          state: 'draft',
        },
        orderBy: [{ updatedAt: 'desc' }],
      }),
    prisma.warehouseAssigneePool.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        active: true,
      },
      orderBy: [{ poolType: 'asc' }, { code: 'asc' }],
    }),
  ]);

  const activeLayout = selectedDraft ?? liveLayout;

  const [nodes, tasksResponse, exceptionsResponse, analysis] = await Promise.all([
    prisma.warehouseLayoutNode.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        layoutVersionId: activeLayout.id,
      },
      orderBy: [{ zIndex: 'asc' }, { createdAt: 'asc' }],
      include: {
        zone: {
          select: { id: true, code: true, name: true, zoneType: true },
        },
        bin: {
          select: { id: true, code: true, binType: true, pickFaceEnabled: true },
        },
      },
    }),
    listSiteTasks(orgId, siteId),
    listSiteExceptions(orgId, siteId),
    activeLayout.state === 'draft' ? buildLayoutDraftAnalysis(prisma, orgId, activeLayout.id, false) : null,
  ]);

  const nodeByBinId = new Map(nodes.filter((node) => node.domainType === 'warehouse.bin').map((node) => [node.domainId, node]));
  const zoneNodes = nodes.filter((node) => node.domainType === 'warehouse.zone');
  const maxX = nodes.reduce((value, node) => Math.max(value, node.x + node.width), 0);
  const maxY = nodes.reduce((value, node) => Math.max(value, node.y + node.height), 0);
  const dispatchAnchor = {
    x: maxX + 2.4,
    y: 1.6,
    label: 'Dispatch',
  };

  const routes = tasksResponse.results
    .map((task) => {
      const fromNode = (task.sourceBinId ? nodeByBinId.get(task.sourceBinId) : null)
        ?? (task.binId ? nodeByBinId.get(task.binId) : null)
        ?? null;
      const toNode = task.targetBinId
        ? nodeByBinId.get(task.targetBinId) ?? null
        : null;

      if (!fromNode && !toNode) {
        return null;
      }

      const from = fromNode
        ? { ...nodeCenter(fromNode), label: fromNode.label ?? fromNode.domainId, nodeId: fromNode.id }
        : dispatchAnchor;
      const to = toNode
        ? { ...nodeCenter(toNode), label: toNode.label ?? toNode.domainId, nodeId: toNode.id }
        : dispatchAnchor;

      return {
        id: `route:${task.id}`,
        taskId: task.id,
        taskType: task.taskType,
        status: task.status,
        priority: task.priority,
        from,
        to,
      };
    })
    .filter(Boolean);

  const focusTargets = [
    ...zoneNodes.slice(0, 6).map((node) => ({
      id: `zone:${node.id}`,
      label: node.label ?? node.zone?.code ?? 'Zone',
      kind: 'zone',
      nodeId: node.id,
      x: node.x,
      y: node.y,
    })),
    ...tasksResponse.results.slice(0, 6).map((task) => ({
      id: `task:${task.id}`,
      label: task.title,
      kind: 'task',
      nodeId: task.sourceBinId ? (nodeByBinId.get(task.sourceBinId)?.id ?? null) : null,
      x: task.sourceBinId ? (nodeByBinId.get(task.sourceBinId)?.x ?? 0) : dispatchAnchor.x,
      y: task.sourceBinId ? (nodeByBinId.get(task.sourceBinId)?.y ?? 0) : dispatchAnchor.y,
    })),
  ];

  return {
    site,
    layout: {
      mode: selectedDraft ? 'draft' : 'live',
      liveVersion: liveLayout,
      activeVersion: activeLayout,
      draftVersion: selectedDraft,
      availableDrafts,
      historyVersions,
      nodes,
      analysis,
    },
    assigneePools,
    tasks: tasksResponse.results,
    exceptions: exceptionsResponse.results,
    routes,
    focusTargets,
    camera: {
      dispatchAnchor,
      overviewCenter: {
        x: (maxX / 2) || 2,
        y: (maxY / 2) || 2,
      },
    },
  };
}

// ─── Layout rollback ──────────────────────────────────────────────────────────

/**
 * Atomically rolls the site's published layout back to a specific prior version.
 * The previously-published version is archived.  Any tasks paused by a force-publish
 * that target nodes present in the rollback version are re-queued automatically.
 * An audit record is written in the same transaction.
 */
export async function rollbackLayoutToVersion(orgId: string, siteId: string, input: {
  targetVersionId: string;
  actorName?: string | null;
  reason?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const site = await ensureSiteAccess(tx, orgId, siteId);

    const targetVersion = await tx.warehouseLayoutVersion.findFirst({
      where: { id: input.targetVersionId, orgId, warehouseSiteId: siteId },
    });

    if (!targetVersion) {
      throw new AppError(404, 'Target layout version not found', 'NOT_FOUND');
    }

    if (!['published', 'archived'].includes(targetVersion.state)) {
      throw new AppError(409, 'Only published or archived versions can be rolled back to', 'CONFLICT');
    }

    const previousVersionId = site.publishedLayoutVersionId;
    if (previousVersionId === input.targetVersionId) {
      throw new AppError(409, 'Target version is already the published version', 'CONFLICT');
    }

    // Archive the current published version if it exists
    if (previousVersionId) {
      await tx.warehouseLayoutVersion.updateMany({
        where: { id: previousVersionId, orgId, warehouseSiteId: siteId },
        data: { state: 'archived' },
      });
    }

    // Re-publish the target version
    const restored = await tx.warehouseLayoutVersion.update({
      where: { id: input.targetVersionId },
      data: {
        state: 'published',
        publishedAt: new Date(),
      },
    });

    // Update the site pointer
    await tx.warehouseSite.update({
      where: { id: siteId },
      data: { publishedLayoutVersionId: input.targetVersionId },
    });

    // Re-queue paused tasks that were paused due to a force-publish, if their
    // source/target bins exist in the restored layout
    const restoredNodeDomainIds = await tx.warehouseLayoutNode.findMany({
      where: { orgId, warehouseSiteId: siteId, layoutVersionId: restored.id, hidden: false },
      select: { domainId: true, domainType: true },
    });
    const restoredBinIds = new Set(
      restoredNodeDomainIds.filter((n) => n.domainType === 'warehouse.bin').map((n) => n.domainId),
    );

    const pausedByForce = await tx.warehouseTask.findMany({
      where: {
        orgId,
        warehouseSiteId: siteId,
        status: 'paused',
      },
      select: {
        id: true,
        sourceBinId: true,
        targetBinId: true,
        metadataJson: true,
        warehouseSiteId: true,
      },
    });

    const now = new Date();
    for (const task of pausedByForce) {
      const meta = asRecord(task.metadataJson);
      if (!meta.publishForceAt) continue;
      const binOk = (
        (!task.sourceBinId || restoredBinIds.has(task.sourceBinId))
        && (!task.targetBinId || restoredBinIds.has(task.targetBinId))
      );
      if (!binOk) continue;

      await tx.warehouseTask.update({
        where: { id: task.id },
        data: {
          status: 'queued',
          metadataJson: {
            ...meta,
            publishForceAt: undefined,
            publishForceReason: undefined,
            rollbackRestoredAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      await appendTaskEvent(tx, {
        orgId,
        warehouseSiteId: task.warehouseSiteId,
        taskId: task.id,
        eventType: 'task.rollback_requeued',
        actorName: input.actorName?.trim() || 'Warehouse Supervisor',
        payload: {
          targetVersionId: input.targetVersionId,
          previousVersionId: previousVersionId ?? null,
        },
      });
    }

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: siteId,
      aggregateType: 'warehouse.layout',
      aggregateId: restored.id,
      eventType: 'warehouse.layout.rolled_back',
      payload: {
        layoutVersionId: restored.id,
        warehouseSiteId: siteId,
        previousVersionId: previousVersionId ?? null,
        reason: normalizeNotes(input.reason),
        actorName: input.actorName?.trim() || 'Warehouse Supervisor',
      },
    });

    await tx.warehouseLayoutPublishAudit.create({
      data: {
        orgId,
        warehouseSiteId: siteId,
        layoutVersionId: restored.id,
        action: 'rollback',
        actorName: input.actorName?.trim() || 'Warehouse Supervisor',
        forceReason: normalizeNotes(input.reason),
        previousVersionId: previousVersionId ?? null,
        impactedTaskCount: pausedByForce.length,
      },
    });

    return {
      restored,
      previousVersionId,
      requeuedTaskCount: pausedByForce.filter((task) => asRecord(task.metadataJson).publishForceAt).length,
    };
  });
}

// ─── Publish audit log ────────────────────────────────────────────────────────

export async function getLayoutPublishAuditLog(orgId: string, siteId: string, options?: {
  limit?: number;
}) {
  await ensureSiteAccess(prisma, orgId, siteId);
  const limit = Math.min(options?.limit ?? 20, 100);

  const records = await prisma.warehouseLayoutPublishAudit.findMany({
    where: { orgId, warehouseSiteId: siteId },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
  });

  return {
    count: records.length,
    results: records,
  };
}
