import type { Prisma } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { paginate, paginatedResponse, type PaginationParams } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { serializeTask } from '../frontend-compat/crm-compat.js';

type TaskListParams = PaginationParams & {
  status?: string;
  priority?: string;
  dealId?: string;
  mine?: boolean;
  dueToday?: boolean;
  overdue?: boolean;
};

type TaskContext = {
  userId: string;
  userFullName: string;
};

type CreateTaskInput = {
  title: string;
  description?: string;
  priority?: string;
  assignedTo?: string;
  assignedName?: string;
  createdBy?: string;
  taskType?: string;
  dueDate?: string;
  due_at?: string;
  dealId?: string;
  deal_id?: string;
  customer_id?: string;
  linkedEntityType?: string;
  linkedEntityId?: string;
  linkedEntityTitle?: string;
  tags?: string[];
};

function hasOwn(source: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function readString(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : '';
}

function readDateValue(value: unknown) {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function mapIncomingStatus(status: string | undefined) {
  if (!status) {
    return undefined;
  }

  if (status === 'open') {
    return 'todo';
  }

  return status;
}

function buildPriorityFilter(priority: string) {
  if (priority === 'high') {
    return { in: ['high', 'critical'] };
  }

  return priority;
}

function getDayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return { start, end };
}

export async function list(orgId: string, params: TaskListParams, context: TaskContext) {
  const where: Prisma.TaskWhereInput = { orgId };
  const andConditions: Prisma.TaskWhereInput[] = [];
  const { start: dayStart, end: dayEnd } = getDayBounds();

  if (params.status) {
    if (params.status === 'open') {
      andConditions.push({ status: { not: 'done' } });
    } else if (params.status === 'done') {
      andConditions.push({ status: 'done' });
    } else {
      andConditions.push({ status: params.status });
    }
  }

  if (params.priority) {
    andConditions.push({ priority: buildPriorityFilter(params.priority) });
  }

  if (params.dealId) {
    andConditions.push({ dealId: params.dealId });
  }

  if (params.mine) {
    andConditions.push({
      OR: [
        { assignedTo: context.userId },
        { assignedName: context.userFullName },
        { createdBy: context.userFullName },
      ],
    });
  }

  if (params.dueToday) {
    andConditions.push({
      dueDate: {
        gte: dayStart,
        lt: dayEnd,
      },
    });
    andConditions.push({ status: { not: 'done' } });
  }

  if (params.overdue) {
    andConditions.push({
      dueDate: { lt: dayStart },
    });
    andConditions.push({ status: { not: 'done' } });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  const [items, total] = await Promise.all([
    prisma.task.findMany({
      where,
      ...paginate(params),
      orderBy: { createdAt: 'desc' },
      include: {
        deal: {
          include: {
            customer: true,
          },
        },
      },
    }),
    prisma.task.count({ where }),
  ]);

  return paginatedResponse(items.map((item) => serializeTask(item)), total, params);
}

export async function getById(orgId: string, id: string) {
  const task = await prisma.task.findFirst({
    where: { id, orgId },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  if (!task) {
    throw new NotFoundError('Task', id);
  }

  return serializeTask(task);
}

export async function create(orgId: string, data: CreateTaskInput, context: TaskContext) {
  const title = data.title.trim();
  if (!title) {
    throw new ValidationError('Task title is required');
  }

  const resolvedDealId = data.dealId ?? data.deal_id;
  const dueDate = readDateValue(data.due_at ?? data.dueDate);
  const priority = data.priority ?? 'medium';

  let deal = null;
  if (resolvedDealId) {
    deal = await prisma.deal.findFirst({
      where: {
        id: resolvedDealId,
        orgId,
      },
      include: {
        customer: true,
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal', resolvedDealId);
    }
  }

  let customer = null;
  if (data.customer_id) {
    customer = await prisma.customer.findFirst({
      where: {
        id: data.customer_id,
        orgId,
      },
    });

    if (!customer) {
      throw new NotFoundError('Customer', data.customer_id);
    }
  }

  const linkedEntityType = deal
    ? 'deal'
    : customer
      ? 'customer'
      : data.linkedEntityType;
  const linkedEntityId = deal?.id ?? customer?.id ?? data.linkedEntityId;
  const linkedEntityTitle = deal?.title ?? customer?.fullName ?? data.linkedEntityTitle;

  const task = await prisma.task.create({
    data: {
      orgId,
      dealId: deal?.id,
      title,
      description: data.description,
      priority,
      assignedTo: data.assignedTo ?? context.userId,
      assignedName: data.assignedName ?? context.userFullName,
      createdBy: data.createdBy ?? context.userFullName,
      taskType: data.taskType ?? 'manual',
      dueDate,
      linkedEntityType,
      linkedEntityId,
      linkedEntityTitle,
      tags: data.tags ?? [],
      activities: {
        create: {
          type: 'system',
          content: 'Task created',
          author: context.userFullName,
        },
      },
    },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  if (deal) {
    await prisma.dealActivity.create({
      data: {
        dealId: deal.id,
        type: 'task.created',
        content: title,
        author: context.userFullName,
      },
    });
  }

  return serializeTask(task);
}

export async function update(orgId: string, id: string, data: Record<string, unknown>) {
  const task = await prisma.task.findFirst({
    where: { id, orgId },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  if (!task) {
    throw new NotFoundError('Task', id);
  }

  const updateData: Prisma.TaskUpdateInput = {};
  const incomingStatus = mapIncomingStatus(readString(data.status));

  if (hasOwn(data, 'title')) {
    const title = readString(data.title);
    if (title) {
      updateData.title = title;
    }
  }

  if (hasOwn(data, 'description')) {
    updateData.description = readString(data.description) ?? null;
  }

  if (hasOwn(data, 'status') && incomingStatus) {
    updateData.status = incomingStatus;
    updateData.completedAt = incomingStatus === 'done' ? new Date() : null;
  }

  if (hasOwn(data, 'priority')) {
    const priority = readString(data.priority);
    if (priority) {
      updateData.priority = priority;
    }
  }

  if (hasOwn(data, 'assignedTo') || hasOwn(data, 'assigned_to')) {
    updateData.assignedTo = readString(data.assignedTo) ?? readString(data.assigned_to) ?? null;
  }

  if (hasOwn(data, 'assignedName') || hasOwn(data, 'assigned_name')) {
    updateData.assignedName = readString(data.assignedName) ?? readString(data.assigned_name) ?? null;
  }

  if (hasOwn(data, 'dueDate') || hasOwn(data, 'due_at')) {
    const dueDate = readDateValue(data.dueDate ?? data.due_at);
    if (dueDate !== undefined) {
      updateData.dueDate = dueDate;
    }
  }

  if (hasOwn(data, 'tags')) {
    updateData.tags = (data.tags as string[] | undefined) ?? [];
  }

  const updated = await prisma.task.update({
    where: { id },
    data: updateData,
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  return serializeTask(updated);
}

export async function moveStatus(orgId: string, id: string, status: string, author: string) {
  const task = await prisma.task.findFirst({
    where: { id, orgId },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  if (!task) {
    throw new NotFoundError('Task', id);
  }

  const normalizedStatus = mapIncomingStatus(status) ?? status;
  const updated = await prisma.task.update({
    where: { id },
    data: {
      status: normalizedStatus,
      completedAt: normalizedStatus === 'done' ? new Date() : null,
    },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
  });

  await prisma.taskActivity.create({
    data: {
      taskId: id,
      type: 'status_change',
      content: `${task.status} -> ${normalizedStatus}`,
      author,
    },
  });

  return serializeTask(updated);
}

export async function complete(orgId: string, id: string, author: string) {
  return moveStatus(orgId, id, 'done', author);
}

export async function addSubtask(orgId: string, taskId: string, title: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, orgId } });
  if (!task) {
    throw new NotFoundError('Task', taskId);
  }

  return prisma.taskSubtask.create({
    data: { taskId, title },
  });
}

export async function toggleSubtask(orgId: string, taskId: string, subtaskId: string, done: boolean) {
  const task = await prisma.task.findFirst({ where: { id: taskId, orgId } });
  if (!task) {
    throw new NotFoundError('Task', taskId);
  }

  return prisma.taskSubtask.update({
    where: { id: subtaskId },
    data: { done },
  });
}

export async function addActivity(orgId: string, taskId: string, data: { type: string; content: string; author: string }) {
  const task = await prisma.task.findFirst({ where: { id: taskId, orgId } });
  if (!task) {
    throw new NotFoundError('Task', taskId);
  }

  return prisma.taskActivity.create({
    data: {
      taskId,
      type: data.type,
      content: data.content,
      author: data.author,
    },
  });
}

export async function remove(orgId: string, id: string) {
  const task = await prisma.task.findFirst({ where: { id, orgId } });
  if (!task) {
    throw new NotFoundError('Task', id);
  }

  await prisma.task.delete({ where: { id } });
  return { ok: true };
}
