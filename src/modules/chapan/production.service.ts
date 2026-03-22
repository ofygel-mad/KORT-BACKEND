import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';

// ── Helpers ─────────────────────────────────────────────

async function findTask(orgId: string, taskId: string) {
  const task = await prisma.chapanProductionTask.findFirst({
    where: { id: taskId, order: { orgId } },
    include: { order: true },
  });
  if (!task) throw new NotFoundError('ProductionTask', taskId);
  return task;
}

// ── List production tasks ───────────────────────────────

export async function list(orgId: string, filters?: { status?: string; assignedTo?: string }) {
  const where: Record<string, unknown> = { order: { orgId } };
  if (filters?.status) where.status = filters.status;
  if (filters?.assignedTo) where.assignedTo = filters.assignedTo;

  return prisma.chapanProductionTask.findMany({
    where,
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          priority: true,
          dueDate: true,
          clientName: true,
          clientPhone: true,
        },
      },
    },
    orderBy: [
      { isBlocked: 'desc' },
      { startedAt: 'asc' },
    ],
  });
}

/**
 * List production tasks with client data stripped.
 * For workshop_lead/worker views.
 */
export async function listForWorkshop(orgId: string) {
  const tasks = await prisma.chapanProductionTask.findMany({
    where: {
      order: {
        orgId,
        status: { notIn: ['cancelled', 'completed'] },
      },
    },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          priority: true,
          dueDate: true,
          // NO clientName, clientPhone — privacy
        },
      },
    },
    orderBy: [
      { isBlocked: 'desc' },
      { startedAt: 'asc' },
    ],
  });

  return tasks;
}

// ── Move status ─────────────────────────────────────────

export async function moveStatus(orgId: string, taskId: string, status: string, authorId: string, authorName: string) {
  const task = await findTask(orgId, taskId);

  const now = new Date();

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: {
        status,
        startedAt: status !== 'pending' && !task.startedAt ? now : undefined,
        completedAt: status === 'done' ? now : undefined,
      },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: `${task.productName}: ${task.status} → ${status}`,
        authorId,
        authorName,
      },
    }),
  ]);

  // Check if all tasks for this order are done → auto-set order to 'ready'
  if (status === 'done') {
    const allTasks = await prisma.chapanProductionTask.findMany({
      where: { orderId: task.orderId },
    });
    const allDone = allTasks.every((t) => t.id === taskId || t.status === 'done');

    if (allDone) {
      await prisma.$transaction([
        prisma.chapanOrder.update({
          where: { id: task.orderId },
          data: { status: 'ready' },
        }),
        prisma.chapanActivity.create({
          data: {
            orderId: task.orderId,
            type: 'status_change',
            content: 'В производстве → Готов (все задачи выполнены)',
            authorId,
            authorName,
          },
        }),
      ]);
    }
  }
}

// ── Assign worker ───────────────────────────────────────

export async function assignWorker(orgId: string, taskId: string, worker: string) {
  await findTask(orgId, taskId);

  return prisma.chapanProductionTask.update({
    where: { id: taskId },
    data: { assignedTo: worker },
  });
}

// ── Flag/unflag task ────────────────────────────────────

export async function flagTask(orgId: string, taskId: string, reason: string, authorId: string, authorName: string) {
  const task = await findTask(orgId, taskId);

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: { isBlocked: true, blockReason: reason },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: `${task.productName}: заблокировано — ${reason}`,
        authorId,
        authorName,
      },
    }),
  ]);
}

export async function unflagTask(orgId: string, taskId: string, authorId: string, authorName: string) {
  const task = await findTask(orgId, taskId);

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: { isBlocked: false, blockReason: null },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: `${task.productName}: блокировка снята`,
        authorId,
        authorName,
      },
    }),
  ]);
}

// ── Set defect ──────────────────────────────────────────

export async function setDefect(orgId: string, taskId: string, defect: string) {
  await findTask(orgId, taskId);

  return prisma.chapanProductionTask.update({
    where: { id: taskId },
    data: { defects: defect || null },
  });
}
