/**
 * Warehouse Execution Engine
 *
 * Replaces the "system.materialized + heuristics" task loop with an explicit
 * execution layer that supports:
 *   - Tasks created from typed domain events (reservation, document, operator command)
 *   - Assignment policies per pool (fifo | round_robin | skill_match)
 *   - SLA escalation: when a task's dueAt is breached and it hasn't been escalated,
 *     move it to the pool's escalationPool (typically the supervisor desk)
 *
 * Strategy field values:
 *   system.materialized  — legacy heuristic sync (still runs for backward compat)
 *   execution.engine     — tasks managed by this engine
 */

import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';

type Tx = Prisma.TransactionClient | PrismaClient;

function addMinutes(base: Date, minutes: number) {
  return new Date(base.getTime() + minutes * 60_000);
}

function computeSlaStatus(status: string, dueAt?: Date | null, now = new Date()) {
  if (['completed', 'cancelled', 'resolved'].includes(status)) return 'closed';
  if (!dueAt) return 'on_track';
  const diff = dueAt.getTime() - now.getTime();
  if (diff <= 0) return 'breached';
  if (diff <= 30 * 60_000) return 'at_risk';
  return 'on_track';
}

function deriveSlaTimeoutMin(pool: { slaTimeoutMin: number }, taskType: string, priority: string) {
  if (pool.slaTimeoutMin > 0) return pool.slaTimeoutMin;
  if (taskType === 'pick') return priority === 'high' ? 20 : 75;
  if (taskType === 'replenishment') return priority === 'high' ? 25 : 120;
  if (taskType === 'putaway') return 240;
  return 180;
}

// ─── Assignment policy ────────────────────────────────────────────────────────

/**
 * Pick the next assignee name/role from the pool using the configured policy.
 * For round_robin, we use the current active-task count per pool member as a
 * simple load metric (no explicit roster table yet — can be extended later).
 */
export async function resolvePoolAssignment(
  db: Tx,
  pool: { id: string; assignmentPolicy: string; poolType: string; code: string },
  candidates: Array<{ name: string; role?: string | null }>,
): Promise<{ assigneeName: string; assigneeRole: string }> {
  if (!candidates.length) {
    return { assigneeName: 'Unassigned', assigneeRole: pool.poolType };
  }

  if (pool.assignmentPolicy === 'round_robin') {
    const poolTaskCounts = await db.warehouseTask.groupBy({
      by: ['assigneeName'],
      where: {
        assigneePoolId: pool.id,
        status: { notIn: ['completed', 'cancelled'] },
        assigneeName: { in: candidates.map((c) => c.name) },
      },
      _count: { id: true },
    });

    const countByName = new Map(poolTaskCounts.map((row) => [row.assigneeName, row._count.id]));
    const sorted = [...candidates].sort((left, right) => (
      (countByName.get(left.name) ?? 0) - (countByName.get(right.name) ?? 0)
    ));
    const chosen = sorted[0]!;
    return { assigneeName: chosen.name, assigneeRole: chosen.role ?? pool.poolType };
  }

  // fifo and skill_match: pick first available candidate
  const chosen = candidates[0]!;
  return { assigneeName: chosen.name, assigneeRole: chosen.role ?? pool.poolType };
}

// ─── Explicit task creation from domain events ────────────────────────────────

export interface CreateEngineTaskInput {
  orgId: string;
  warehouseSiteId: string;
  taskType: 'pick' | 'putaway' | 'replenishment' | 'count';
  priority: 'high' | 'normal' | 'low';
  title: string;
  description?: string | null;
  externalKey: string;
  routeKey?: string | null;
  sourceType: string;
  sourceId: string;
  sourceLineId?: string | null;
  zoneId?: string | null;
  binId?: string | null;
  sourceBinId?: string | null;
  targetBinId?: string | null;
  variantId?: string | null;
  reservationId?: string | null;
  assigneePoolId?: string | null;
  metadataJson?: Record<string, unknown>;
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

/**
 * Create or idempotently update a task from an explicit domain event.
 * Unlike system.materialized, each call carries a real business reason.
 */
export async function createOrUpdateEngineTask(orgId: string, input: CreateEngineTaskInput) {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

    const pool = input.assigneePoolId
      ? await tx.warehouseAssigneePool.findFirst({
        where: { id: input.assigneePoolId, orgId },
        select: { id: true, code: true, poolType: true, assignmentPolicy: true, slaTimeoutMin: true },
      })
      : null;

    const timeoutMin = pool
      ? deriveSlaTimeoutMin(pool, input.taskType, input.priority)
      : (input.priority === 'high' ? 30 : 120);
    const dueAt = addMinutes(now, timeoutMin);
    const slaStatus = computeSlaStatus('queued', dueAt, now);

    const existing = await tx.warehouseTask.findFirst({
      where: { orgId, warehouseSiteId: input.warehouseSiteId, externalKey: input.externalKey },
    });

    if (existing) {
      const preservedStatus = ['assigned', 'accepted', 'in_progress', 'paused'].includes(existing.status)
        ? existing.status
        : 'queued';

      const updated = await tx.warehouseTask.update({
        where: { id: existing.id },
        data: {
          priority: input.priority,
          title: input.title,
          description: input.description ?? null,
          zoneId: input.zoneId ?? null,
          binId: input.binId ?? null,
          sourceBinId: input.sourceBinId ?? null,
          targetBinId: input.targetBinId ?? null,
          variantId: input.variantId ?? null,
          reservationId: input.reservationId ?? null,
          assigneePoolId: input.assigneePoolId ?? existing.assigneePoolId ?? null,
          routeKey: input.routeKey ?? null,
          metadataJson: input.metadataJson ? (input.metadataJson as Prisma.InputJsonValue) : undefined,
          status: preservedStatus,
          dueAt,
          slaStatus: computeSlaStatus(preservedStatus, dueAt, now),
        },
      });

      await appendTaskEvent(tx, {
        orgId,
        warehouseSiteId: input.warehouseSiteId,
        taskId: updated.id,
        eventType: 'task.engine_refreshed',
        payload: { externalKey: input.externalKey, taskType: input.taskType },
      });

      return { created: false, task: updated };
    }

    const task = await tx.warehouseTask.create({
      data: {
        orgId,
        warehouseSiteId: input.warehouseSiteId,
        taskType: input.taskType,
        status: 'queued',
        priority: input.priority,
        title: input.title,
        description: input.description ?? null,
        externalKey: input.externalKey,
        routeKey: input.routeKey ?? null,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineId: input.sourceLineId ?? null,
        zoneId: input.zoneId ?? null,
        binId: input.binId ?? null,
        sourceBinId: input.sourceBinId ?? null,
        targetBinId: input.targetBinId ?? null,
        variantId: input.variantId ?? null,
        reservationId: input.reservationId ?? null,
        assigneePoolId: input.assigneePoolId ?? null,
        sourceStrategy: 'execution.engine',
        dueAt,
        slaStatus,
        metadataJson: input.metadataJson ? (input.metadataJson as Prisma.InputJsonValue) : undefined,
      },
    });

    await appendTaskEvent(tx, {
      orgId,
      warehouseSiteId: input.warehouseSiteId,
      taskId: task.id,
      eventType: 'task.engine_created',
      payload: {
        externalKey: input.externalKey,
        taskType: input.taskType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        assigneePoolId: input.assigneePoolId ?? null,
      },
    });

    await createOutboxRecord(tx, {
      orgId,
      warehouseSiteId: input.warehouseSiteId,
      aggregateType: 'warehouse.task',
      aggregateId: task.id,
      eventType: 'warehouse.task.engine_created',
      payload: {
        taskId: task.id,
        warehouseSiteId: input.warehouseSiteId,
        taskType: input.taskType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        externalKey: input.externalKey,
      },
    });

    return { created: true, task };
  });
}

// ─── SLA escalation ───────────────────────────────────────────────────────────

/**
 * Find tasks where SLA is breached and escalation_level = 0.
 * Move them to the pool's escalation_pool_id (supervisor desk), record the event,
 * and bump escalation_level to 1.
 *
 * A second call with already-escalated tasks (level 1) will escalate again to
 * any chained escalation pool if one is configured, bumping level to 2 (critical).
 */
export async function escalateSlaBreachedTasks(orgId: string, siteId: string): Promise<{
  escalated: number;
  details: Array<{ taskId: string; escalationLevel: number; toPoolId: string | null }>;
}> {
  const now = new Date();

  const site = await prisma.warehouseSite.findFirst({
    where: { id: siteId, orgId },
    select: { id: true },
  });
  if (!site) throw new AppError(404, 'Warehouse site not found', 'NOT_FOUND');

  const pools = await prisma.warehouseAssigneePool.findMany({
    where: { orgId, warehouseSiteId: siteId, active: true },
    select: {
      id: true,
      code: true,
      poolType: true,
      escalationPoolId: true,
      escalationPool: {
        select: { id: true, code: true, poolType: true },
      },
    },
  });

  const poolMap = new Map(pools.map((pool) => [pool.id, pool]));
  const escalationPoolMap = new Map(
    pools
      .filter((pool) => pool.escalationPoolId)
      .map((pool) => [pool.id, pool.escalationPoolId!]),
  );

  const breachedTasks = await prisma.warehouseTask.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      slaStatus: 'breached',
      escalationLevel: { lt: 2 },
      status: { notIn: ['completed', 'cancelled'] },
      dueAt: { lt: now },
    },
    select: {
      id: true,
      title: true,
      taskType: true,
      status: true,
      escalationLevel: true,
      assigneePoolId: true,
      dueAt: true,
    },
  });

  if (!breachedTasks.length) return { escalated: 0, details: [] };

  const details: Array<{ taskId: string; escalationLevel: number; toPoolId: string | null }> = [];

  await prisma.$transaction(async (tx) => {
    for (const task of breachedTasks) {
      const currentPool = task.assigneePoolId ? poolMap.get(task.assigneePoolId) : null;
      const targetPoolId = task.assigneePoolId
        ? (escalationPoolMap.get(task.assigneePoolId) ?? null)
        : pools.find((p) => p.poolType === 'exception')?.id ?? null;

      const newLevel = task.escalationLevel + 1;

      await tx.warehouseTask.update({
        where: { id: task.id },
        data: {
          escalationLevel: newLevel,
          escalatedAt: now,
          assigneePoolId: targetPoolId ?? task.assigneePoolId,
          slaStatus: 'breached',
        },
      });

      await tx.warehouseTaskEvent.create({
        data: {
          orgId,
          warehouseSiteId: siteId,
          taskId: task.id,
          eventType: 'task.sla_escalated',
          actorName: 'Execution Engine',
          payloadJson: {
            escalationLevel: newLevel,
            fromPoolId: task.assigneePoolId ?? null,
            fromPoolCode: currentPool?.code ?? null,
            toPoolId: targetPoolId ?? null,
            toPoolCode: targetPoolId ? (poolMap.get(targetPoolId)?.code ?? null) : null,
            breachedAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      await createOutboxRecord(tx, {
        orgId,
        warehouseSiteId: siteId,
        aggregateType: 'warehouse.task',
        aggregateId: task.id,
        eventType: 'warehouse.task.sla_escalated',
        payload: {
          taskId: task.id,
          warehouseSiteId: siteId,
          escalationLevel: newLevel,
          toPoolId: targetPoolId ?? null,
        },
      });

      details.push({ taskId: task.id, escalationLevel: newLevel, toPoolId: targetPoolId });
    }
  });

  return { escalated: details.length, details };
}

// ─── Pool assignment policy management ───────────────────────────────────────

export async function updatePoolAssignmentPolicy(
  orgId: string,
  poolId: string,
  input: {
    assignmentPolicy?: 'fifo' | 'round_robin' | 'skill_match';
    slaTimeoutMin?: number;
    escalationPoolId?: string | null;
  },
) {
  const pool = await prisma.warehouseAssigneePool.findFirst({
    where: { id: poolId, orgId },
  });
  if (!pool) throw new AppError(404, 'Assignee pool not found', 'NOT_FOUND');

  if (input.escalationPoolId) {
    const targetPool = await prisma.warehouseAssigneePool.findFirst({
      where: { id: input.escalationPoolId, orgId, warehouseSiteId: pool.warehouseSiteId },
    });
    if (!targetPool) {
      throw new AppError(404, 'Escalation target pool not found or belongs to different site', 'NOT_FOUND');
    }
    if (input.escalationPoolId === poolId) {
      throw new AppError(409, 'A pool cannot escalate to itself', 'CONFLICT');
    }
  }

  return prisma.warehouseAssigneePool.update({
    where: { id: pool.id },
    data: {
      assignmentPolicy: input.assignmentPolicy ?? pool.assignmentPolicy,
      slaTimeoutMin: input.slaTimeoutMin ?? pool.slaTimeoutMin,
      escalationPoolId: 'escalationPoolId' in input ? (input.escalationPoolId ?? null) : pool.escalationPoolId,
    },
  });
}

// ─── Route history from real task events ─────────────────────────────────────

/**
 * Build a route replay history from WarehouseTaskEvent records.
 * Events of type task.assign / task.start / task.complete contain the route
 * (sourceBin → targetBin).  We reconstruct them into ordered segments suitable
 * for the Twin's routeReplay UI.
 */
export async function getRouteHistoryFromEvents(orgId: string, siteId: string, options?: {
  limit?: number;
  taskType?: string;
  since?: Date;
}) {
  await prisma.warehouseSite.findFirst({ where: { id: siteId, orgId }, select: { id: true } })
    .then((site) => { if (!site) throw new AppError(404, 'Site not found', 'NOT_FOUND'); });

  const limit = Math.min(options?.limit ?? 60, 200);
  const since = options?.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);

  const recentTasks = await prisma.warehouseTask.findMany({
    where: {
      orgId,
      warehouseSiteId: siteId,
      ...(options?.taskType ? { taskType: options.taskType } : {}),
      createdAt: { gte: since },
      status: { not: 'cancelled' },
      sourceBinId: { not: null },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: limit,
    include: {
      sourceBin: {
        select: {
          id: true,
          code: true,
          zoneId: true,
          zone: { select: { id: true, code: true, name: true } },
        },
      },
      targetBin: {
        select: {
          id: true,
          code: true,
          zoneId: true,
          zone: { select: { id: true, code: true, name: true } },
        },
      },
      variant: {
        include: { productCatalog: { select: { name: true } } },
      },
      events: {
        where: {
          eventType: { in: ['task.start', 'task.complete', 'task.replenish', 'task.engine_created', 'task.materialized_created'] },
        },
        orderBy: [{ createdAt: 'asc' }],
        take: 4,
      },
    },
  });

  const segments = recentTasks.map((task) => {
    const startEvent = task.events.find((ev) => ev.eventType === 'task.start' || ev.eventType === 'task.engine_created');
    const completeEvent = task.events.find((ev) => ev.eventType === 'task.complete' || ev.eventType === 'task.replenish');

    return {
      taskId: task.id,
      taskType: task.taskType,
      status: task.status,
      priority: task.priority,
      slaStatus: task.slaStatus,
      escalationLevel: task.escalationLevel,
      title: task.title,
      variantLabel: task.variant?.productCatalog?.name ?? task.variant?.variantKey ?? null,
      from: task.sourceBin ? {
        binId: task.sourceBinId,
        binCode: task.sourceBin.code,
        zoneId: task.sourceBin.zoneId,
        zoneCode: task.sourceBin.zone?.code ?? null,
      } : null,
      to: task.targetBin ? {
        binId: task.targetBinId,
        binCode: task.targetBin.code,
        zoneId: task.targetBin.zoneId,
        zoneCode: task.targetBin.zone?.code ?? null,
      } : null,
      startedAt: startEvent?.createdAt?.toISOString() ?? task.startedAt?.toISOString() ?? null,
      completedAt: completeEvent?.createdAt?.toISOString() ?? task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      sourceStrategy: task.sourceStrategy,
      actorName: startEvent?.actorName ?? task.assigneeName ?? null,
    };
  });

  return {
    count: segments.length,
    since: since.toISOString(),
    segments,
  };
}
