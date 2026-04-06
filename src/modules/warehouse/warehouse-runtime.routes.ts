import type { FastifyPluginAsync } from 'fastify';
import * as svc from './warehouse-runtime.service.js';
import * as engine from './warehouse-execution-engine.service.js';

export const warehouseRuntimeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.resolveOrg);

  app.post<{ Params: { siteId: string } }>('/foundation/sites/:siteId/operational/sync', async (req) => {
    return svc.syncWarehouseOperationalState(req.orgId!, req.params.siteId);
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { status?: string; taskType?: string };
  }>('/foundation/sites/:siteId/tasks', async (req) => {
    return svc.listSiteTasks(req.orgId!, req.params.siteId, {
      status: req.query.status,
      taskType: req.query.taskType,
    });
  });

  app.get<{ Params: { siteId: string } }>('/foundation/sites/:siteId/assignee-pools', async (req) => {
    return svc.listAssigneePools(req.orgId!, req.params.siteId);
  });

  app.get<{ Params: { taskId: string } }>('/foundation/tasks/:taskId/timeline', async (req) => {
    return svc.getTaskTimeline(req.orgId!, req.params.taskId);
  });

  app.get<{ Params: { exceptionId: string } }>('/foundation/exceptions/:exceptionId/timeline', async (req) => {
    return svc.getExceptionTimeline(req.orgId!, req.params.exceptionId);
  });

  app.get<{
    Querystring: { leftVersionId: string; rightVersionId: string };
  }>('/foundation/layout-versions/compare', async (req) => {
    return svc.compareLayoutVersions(req.orgId!, req.query.leftVersionId, req.query.rightVersionId);
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { status?: string; severity?: string };
  }>('/foundation/sites/:siteId/exceptions', async (req) => {
    return svc.listSiteExceptions(req.orgId!, req.params.siteId, {
      status: req.query.status,
      severity: req.query.severity,
    });
  });

  app.post<{
    Params: { taskId: string };
    Body: { status: string };
  }>('/foundation/tasks/:taskId/status', async (req) => {
    return svc.updateTaskStatus(req.orgId!, req.params.taskId, {
      ...req.body,
      actorName: req.userFullName ?? 'Warehouse Twin',
    });
  });

  app.post<{
    Params: { taskId: string };
    Body: {
      command: 'assign' | 'start' | 'pause' | 'complete' | 'cancel' | 'replenish';
      assigneeName?: string;
      assigneeRole?: string;
      poolId?: string;
    };
  }>('/foundation/tasks/:taskId/command', async (req) => {
    return svc.commandTask(req.orgId!, req.params.taskId, {
      command: req.body.command,
      assigneeName: req.body.assigneeName,
      assigneeRole: req.body.assigneeRole,
      poolId: req.body.poolId,
      actorName: req.userFullName ?? 'Warehouse Twin',
    });
  });

  app.post<{
    Params: { exceptionId: string };
    Body: { status: string };
  }>('/foundation/exceptions/:exceptionId/status', async (req) => {
    return svc.updateExceptionStatus(req.orgId!, req.params.exceptionId, {
      ...req.body,
      actorName: req.userFullName ?? 'Warehouse Twin',
    });
  });

  app.post<{
    Params: { exceptionId: string };
    Body: {
      command: 'assign' | 'acknowledge' | 'resolve' | 'escalate' | 'reopen';
      ownerName?: string;
      ownerRole?: string;
      poolId?: string;
      resolutionCode?: string;
    };
  }>('/foundation/exceptions/:exceptionId/command', async (req) => {
    return svc.commandException(req.orgId!, req.params.exceptionId, {
      command: req.body.command,
      ownerName: req.body.ownerName,
      ownerRole: req.body.ownerRole,
      poolId: req.body.poolId,
      resolutionCode: req.body.resolutionCode,
      actorName: req.userFullName ?? 'Warehouse Twin',
    });
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { draftVersionId?: string };
  }>('/foundation/sites/:siteId/twin', async (req) => {
    return svc.getWarehouseTwinRuntime(req.orgId!, req.params.siteId, {
      draftVersionId: req.query.draftVersionId,
    });
  });

  app.post<{
    Params: { siteId: string };
    Body?: { notes?: string };
  }>('/foundation/sites/:siteId/layout-drafts', async (req, reply) => {
    const result = await svc.createLayoutDraft(
      req.orgId!,
      req.params.siteId,
      req.userFullName ?? 'system',
      req.body?.notes,
    );
    return reply.status(201).send(result);
  });

  app.patch<{
    Params: { draftId: string; nodeId: string };
    Body: {
      x?: number | string;
      y?: number | string;
      width?: number | string;
      height?: number | string;
      rotation?: number | string;
      hidden?: boolean;
    };
  }>('/foundation/layout-drafts/:draftId/nodes/:nodeId', async (req) => {
    return svc.updateLayoutDraftNode(req.orgId!, req.params.draftId, req.params.nodeId, {
      x: req.body.x !== undefined ? Number(req.body.x) : undefined,
      y: req.body.y !== undefined ? Number(req.body.y) : undefined,
      width: req.body.width !== undefined ? Number(req.body.width) : undefined,
      height: req.body.height !== undefined ? Number(req.body.height) : undefined,
      rotation: req.body.rotation !== undefined ? Number(req.body.rotation) : undefined,
      hidden: req.body.hidden,
    });
  });

  app.post<{
    Params: { draftId: string };
  }>('/foundation/layout-drafts/:draftId/validate', async (req) => {
    return svc.validateLayoutDraft(req.orgId!, req.params.draftId);
  });

  app.post<{
    Params: { draftId: string };
    Body?: { force?: boolean; forceReason?: string };
  }>('/foundation/layout-drafts/:draftId/publish', async (req) => {
    return svc.publishLayoutDraft(req.orgId!, req.params.draftId, {
      force: req.body?.force,
      forceReason: req.body?.forceReason,
      actorName: req.userFullName ?? 'Warehouse Supervisor',
    });
  });

  // ── Layout rollback ───────────────────────────────────────────────────────

  app.post<{
    Params: { siteId: string };
    Body: { targetVersionId: string; reason?: string };
  }>('/foundation/sites/:siteId/layout-rollback', async (req) => {
    return svc.rollbackLayoutToVersion(req.orgId!, req.params.siteId, {
      targetVersionId: req.body.targetVersionId,
      reason: req.body.reason,
      actorName: req.userFullName ?? 'Warehouse Supervisor',
    });
  });

  app.get<{
    Params: { siteId: string };
    Querystring: { limit?: string };
  }>('/foundation/sites/:siteId/layout-publish-audit', async (req) => {
    return svc.getLayoutPublishAuditLog(req.orgId!, req.params.siteId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
  });

  // ── Route history (event-sourced replay) ─────────────────────────────────

  app.get<{
    Params: { siteId: string };
    Querystring: { limit?: string; taskType?: string; since?: string };
  }>('/foundation/sites/:siteId/route-history', async (req) => {
    return engine.getRouteHistoryFromEvents(req.orgId!, req.params.siteId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      taskType: req.query.taskType,
      since: req.query.since ? new Date(req.query.since) : undefined,
    });
  });

  // ── SLA escalation trigger ────────────────────────────────────────────────

  app.post<{
    Params: { siteId: string };
  }>('/foundation/sites/:siteId/execution/escalate-sla', async (req) => {
    return engine.escalateSlaBreachedTasks(req.orgId!, req.params.siteId);
  });

  // ── Pool policy management ────────────────────────────────────────────────

  app.patch<{
    Params: { poolId: string };
    Body: {
      assignmentPolicy?: 'fifo' | 'round_robin' | 'skill_match';
      slaTimeoutMin?: number;
      escalationPoolId?: string | null;
    };
  }>('/foundation/assignee-pools/:poolId/policy', async (req) => {
    return engine.updatePoolAssignmentPolicy(req.orgId!, req.params.poolId, req.body);
  });
};
