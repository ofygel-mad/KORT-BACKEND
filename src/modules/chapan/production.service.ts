import { prisma } from '../../lib/prisma.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import {
  deriveOrderStatusFromTasks,
  getProductionStatusLabel,
  normalizeProductionStatus,
} from './workflow.js';

function mapTask<T extends { status: string | null; orderItem?: { color?: string | null; gender?: string | null; length?: string | null; workshopNotes?: string | null } | null }>(task: T) {
  const { orderItem, ...rest } = task;
  return {
    ...rest,
    status: normalizeProductionStatus(task.status),
    color: orderItem?.color ?? null,
    gender: orderItem?.gender ?? null,
    length: orderItem?.length ?? null,
    workshopNotes: orderItem?.workshopNotes ?? null,
  } as Omit<T, 'orderItem'> & { status: ReturnType<typeof normalizeProductionStatus>; color: string | null; gender: string | null; length: string | null; workshopNotes: string | null };
}

function getOrderStatusLabel(status: string) {
  if (status === 'confirmed') return 'Подтвержден';
  if (status === 'in_production') return 'В производстве';
  if (status === 'ready') return 'Готово';
  if (status === 'transferred') return 'Передан';
  if (status === 'completed') return 'Завершен';
  if (status === 'cancelled') return 'Отменен';
  return status;
}

async function findTask(orgId: string, taskId: string) {
  const task = await prisma.chapanProductionTask.findFirst({
    where: { id: taskId, order: { orgId } },
    include: { order: true },
  });

  if (!task) {
    throw new NotFoundError('ProductionTask', taskId);
  }

  if (task.order.isArchived || ['cancelled', 'completed'].includes(task.order.status)) {
    throw new ValidationError('Нельзя изменять задачи у архивного, завершенного или отмененного заказа');
  }

  return task;
}

export async function syncOrderStatus(orderId: string, authorId: string, authorName: string) {
  const [order, items, tasks] = await Promise.all([
    prisma.chapanOrder.findUnique({
      where: { id: orderId },
      select: { status: true },
    }),
    prisma.chapanOrderItem.findMany({
      where: { orderId },
      select: { fulfillmentMode: true },
    }),
    prisma.chapanProductionTask.findMany({
      where: { orderId },
      select: { status: true },
    }),
  ]);

  if (!order) {
    return;
  }

  // If nothing has been routed yet (all items still unassigned), don't advance status
  const hasRoutedItems = items.some((item) => item.fulfillmentMode === 'warehouse' || item.fulfillmentMode === 'production');
  if (!hasRoutedItems) {
    return;
  }

  const hasPendingRouting = items.some((item) => !item.fulfillmentMode || item.fulfillmentMode === 'unassigned');

  if (tasks.length === 0 && hasPendingRouting) {
    if (order.status !== 'confirmed') {
      await prisma.$transaction([
        prisma.chapanOrder.update({ where: { id: orderId }, data: { status: 'confirmed' } }),
        prisma.chapanActivity.create({
          data: {
            orderId,
            type: 'status_change',
            content: `${getOrderStatusLabel(order.status)} в†’ ${getOrderStatusLabel('confirmed')}`,
            authorId,
            authorName,
          },
        }),
      ]);
    }
    return;
  }

  // At least one item is routed. If no production tasks → all routed items went to warehouse → order is ready
  if (tasks.length === 0) {
    const nextStatus = 'ready';
    if (order.status !== nextStatus) {
      await prisma.$transaction([
        prisma.chapanOrder.update({ where: { id: orderId }, data: { status: nextStatus } }),
        prisma.chapanActivity.create({
          data: {
            orderId,
            type: 'status_change',
            content: `${getOrderStatusLabel(order.status)} → ${getOrderStatusLabel('ready')}`,
            authorId,
            authorName,
          },
        }),
      ]);
    }
    return;
  }

  const derivedStatus = deriveOrderStatusFromTasks(tasks.map((task) => task.status));
  const nextStatus = hasPendingRouting && derivedStatus === 'ready' ? 'confirmed' : derivedStatus;

  if (order.status === nextStatus) {
    return;
  }

  await prisma.$transaction([
    prisma.chapanOrder.update({
      where: { id: orderId },
      data: { status: nextStatus },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId,
        type: 'status_change',
        content: `${getOrderStatusLabel(order.status)} → ${getOrderStatusLabel(nextStatus)}`,
        authorId,
        authorName,
      },
    }),
  ]);
}

export async function list(orgId: string, filters?: { status?: string; assignedTo?: string }) {
  const tasks = await prisma.chapanProductionTask.findMany({
    where: {
      ...(filters?.assignedTo ? { assignedTo: filters.assignedTo } : {}),
      order: {
        orgId,
        isArchived: false,
        deletedAt: null,
        status: { notIn: ['cancelled', 'completed'] },
      },
    },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          priority: true,
          urgency: true,
          isDemandingClient: true,
          dueDate: true,
          clientName: true,
          clientPhone: true,
        },
      },
      orderItem: {
        select: {
          color: true,
          gender: true,
          length: true,
          workshopNotes: true,
        },
      },
    },
    orderBy: [
      { isBlocked: 'desc' },
      { startedAt: 'asc' },
    ],
  });

  const activeTasks = tasks
    .map(mapTask)
    .filter((task) => task.status !== 'done');

  if (filters?.status) {
    const normalizedStatus = normalizeProductionStatus(filters.status);
    return activeTasks.filter((task) => task.status === normalizedStatus);
  }

  return activeTasks;
}

export async function listForWorkshop(orgId: string) {
  const tasks = await prisma.chapanProductionTask.findMany({
    where: {
      order: {
        orgId,
        isArchived: false,
        deletedAt: null,
        status: { notIn: ['cancelled', 'completed'] },
      },
    },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          priority: true,
          urgency: true,
          isDemandingClient: true,
          dueDate: true,
        },
      },
      orderItem: {
        select: {
          color: true,
          gender: true,
          length: true,
          workshopNotes: true,
        },
      },
    },
    orderBy: [
      { isBlocked: 'desc' },
      { startedAt: 'asc' },
    ],
  });

  return tasks
    .map(mapTask)
    .filter((task) => task.status !== 'done');
}

export async function moveStatus(orgId: string, taskId: string, status: string, authorId: string, authorName: string): Promise<string> {
  const task = await findTask(orgId, taskId);

  if (task.isBlocked) {
    throw new ValidationError('Сначала снимите блокировку с задания');
  }

  const currentStatus = normalizeProductionStatus(task.status);
  const nextStatus = normalizeProductionStatus(status);
  const now = new Date();

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: {
        status: nextStatus,
        startedAt:
          nextStatus === 'queued'
            ? null
            : (task.startedAt ?? now),
        completedAt: nextStatus === 'done' ? now : null,
      },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: `${task.productName}: ${getProductionStatusLabel(currentStatus)} → ${getProductionStatusLabel(nextStatus)}`,
        authorId,
        authorName,
      },
    }),
  ]);

  await syncOrderStatus(task.orderId, authorId, authorName);
  return task.orderId;
}

export async function claimTask(orgId: string, taskId: string, authorId: string, authorName: string) {
  const task = await findTask(orgId, taskId);

  if (task.isBlocked) {
    throw new ValidationError('Нельзя взять в работу заблокированное задание');
  }

  if (normalizeProductionStatus(task.status) === 'done') {
    throw new ValidationError('Готовое задание нельзя повторно взять в работу');
  }

  const now = new Date();

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: {
        status: 'in_progress',
        assignedTo: authorName,
        startedAt: task.startedAt ?? now,
        completedAt: null,
      },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: `${task.productName}: взято в работу`,
        authorId,
        authorName,
      },
    }),
  ]);

  await syncOrderStatus(task.orderId, authorId, authorName);
}

export async function assignWorker(
  orgId: string,
  taskId: string,
  worker: string | null,
  authorId: string,
  authorName: string,
) {
  const task = await findTask(orgId, taskId);
  const nextWorker = worker?.trim() || null;

  await prisma.$transaction([
    prisma.chapanProductionTask.update({
      where: { id: taskId },
      data: { assignedTo: nextWorker },
    }),
    prisma.chapanActivity.create({
      data: {
        orderId: task.orderId,
        type: 'production_update',
        content: nextWorker
          ? `${task.productName}: назначен исполнитель ${nextWorker}`
          : `${task.productName}: исполнитель снят`,
        authorId,
        authorName,
      },
    }),
  ]);
}

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

export async function setDefect(orgId: string, taskId: string, defect: string) {
  await findTask(orgId, taskId);

  return prisma.chapanProductionTask.update({
    where: { id: taskId },
    data: { defects: defect || null },
  });
}
