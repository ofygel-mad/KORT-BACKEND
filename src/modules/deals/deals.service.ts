import type { Prisma } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { paginate, paginatedResponse, type PaginationParams } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import {
  getDealPipeline,
  serializeDealActivity,
  serializeDealBoardItem,
  serializeDealDetail,
  serializeDealSummary,
} from '../frontend-compat/crm-compat.js';

type CreateDealInput = {
  title: string;
  fullName?: string;
  phone?: string;
  email?: string;
  companyName?: string;
  source?: string;
  value?: number | string | null;
  amount?: number | string | null;
  currency?: string;
  assignedTo?: string;
  assignedName?: string;
  leadId?: string;
  customerId?: string;
  customer_id?: string;
  stageId?: string;
  stage_id?: string;
};

type DealActivityInput = {
  type: string;
  content?: string;
  payload?: {
    body?: string;
    title?: string;
  };
  author: string;
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

function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
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
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}

function extractActivityContent(data: DealActivityInput) {
  const fromPayload = data.payload?.body?.trim() || data.payload?.title?.trim();
  const fromContent = data.content?.trim();
  return fromPayload || fromContent || '';
}

function normalizeActivityType(type: string) {
  if (type === 'note') {
    return 'note.created';
  }

  if (type === 'stage_change') {
    return 'stage.changed';
  }

  return type;
}

export async function list(orgId: string, params: PaginationParams) {
  const where = { orgId };
  const [items, total] = await Promise.all([
    prisma.deal.findMany({
      where,
      ...paginate(params),
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: true,
      },
    }),
    prisma.deal.count({ where }),
  ]);

  return paginatedResponse(items.map((item) => serializeDealSummary(item)), total, params);
}

export async function getBoard(orgId: string) {
  const deals = await prisma.deal.findMany({
    where: { orgId },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });

  return {
    pipeline: getDealPipeline(),
    deals: deals.map((deal) => serializeDealBoardItem(deal)),
    total_open: deals.filter((deal) => !['won', 'lost'].includes(deal.stage)).length,
    total_amount: deals.reduce((sum, deal) => sum + (deal.value ?? 0), 0),
  };
}

export async function getById(orgId: string, id: string) {
  const deal = await prisma.deal.findFirst({
    where: { id, orgId },
    include: {
      customer: true,
    },
  });

  if (!deal) {
    throw new NotFoundError('Deal', id);
  }

  return serializeDealDetail(deal);
}

export async function create(orgId: string, data: CreateDealInput, actorId: string, actorName: string) {
  const customerId = data.customerId ?? data.customer_id;
  const stage = data.stageId ?? data.stage_id ?? 'awaiting_meeting';
  const amount = readNumber(data.amount) ?? readNumber(data.value) ?? 0;

  let customer = null;
  if (customerId) {
    customer = await prisma.customer.findFirst({
      where: {
        id: customerId,
        orgId,
      },
    });

    if (!customer) {
      throw new NotFoundError('Customer', customerId);
    }
  }

  const fullName = data.fullName ?? customer?.fullName;
  if (!fullName?.trim()) {
    throw new ValidationError('Deal customer name is required');
  }

  const deal = await prisma.deal.create({
    data: {
      orgId,
      customerId: customer?.id,
      leadId: data.leadId,
      fullName: fullName.trim(),
      phone: data.phone ?? customer?.phone ?? undefined,
      email: data.email ?? customer?.email ?? undefined,
      companyName: data.companyName ?? customer?.companyName ?? undefined,
      source: data.source ?? undefined,
      title: data.title.trim(),
      stage,
      value: amount,
      currency: data.currency ?? 'KZT',
      assignedTo: data.assignedTo ?? actorId,
      assignedName: data.assignedName ?? actorName,
      activities: {
        create: {
          type: 'system',
          content: 'Deal created',
          author: actorName,
        },
      },
    },
    include: {
      customer: true,
    },
  });

  return serializeDealDetail(deal);
}

export async function update(orgId: string, id: string, data: Record<string, unknown>, authorName: string) {
  const deal = await prisma.deal.findFirst({
    where: { id, orgId },
    include: {
      customer: true,
    },
  });

  if (!deal) {
    throw new NotFoundError('Deal', id);
  }

  const oldStage = deal.stage;
  const nextStage = readString(data.stage_id) ?? readString(data.stage);
  const nextAmount = readNumber(data.amount) ?? readNumber(data.value);
  const expectedCloseAt = readDateValue(data.expected_close_date ?? data.expectedCloseAt);

  const updateData: Prisma.DealUpdateInput = {};

  if (hasOwn(data, 'fullName') || hasOwn(data, 'full_name')) {
    const fullName = readString(data.fullName) ?? readString(data.full_name);
    if (fullName) {
      updateData.fullName = fullName;
    }
  }

  if (hasOwn(data, 'phone')) {
    updateData.phone = readString(data.phone) ?? null;
  }

  if (hasOwn(data, 'email')) {
    updateData.email = readString(data.email) ?? null;
  }

  if (hasOwn(data, 'companyName') || hasOwn(data, 'company_name')) {
    updateData.companyName = readString(data.companyName) ?? readString(data.company_name) ?? null;
  }

  if (hasOwn(data, 'title')) {
    const title = readString(data.title);
    if (title) {
      updateData.title = title;
    }
  }

  if (hasOwn(data, 'stage') || hasOwn(data, 'stage_id')) {
    if (nextStage) {
      updateData.stage = nextStage;
    }
  }

  if (hasOwn(data, 'amount') || hasOwn(data, 'value')) {
    if (nextAmount !== undefined) {
      updateData.value = nextAmount;
    }
  }

  if (hasOwn(data, 'currency')) {
    const currency = readString(data.currency);
    if (currency) {
      updateData.currency = currency;
    }
  }

  if (hasOwn(data, 'assignedTo') || hasOwn(data, 'assigned_to')) {
    updateData.assignedTo = readString(data.assignedTo) ?? readString(data.assigned_to) ?? null;
  }

  if (hasOwn(data, 'assignedName') || hasOwn(data, 'assigned_name')) {
    updateData.assignedName = readString(data.assignedName) ?? readString(data.assigned_name) ?? null;
  }

  if (hasOwn(data, 'qualifierName') || hasOwn(data, 'qualifier_name')) {
    updateData.qualifierName = readString(data.qualifierName) ?? readString(data.qualifier_name) ?? null;
  }

  if (hasOwn(data, 'expected_close_date') || hasOwn(data, 'expectedCloseAt')) {
    if (expectedCloseAt !== undefined) {
      updateData.expectedCloseAt = expectedCloseAt;
    }
  }

  if (hasOwn(data, 'meetingAt') || hasOwn(data, 'meeting_at')) {
    const meetingAt = readDateValue(data.meetingAt ?? data.meeting_at);
    if (meetingAt !== undefined) {
      updateData.meetingAt = meetingAt;
    }
  }

  if (hasOwn(data, 'notes')) {
    updateData.notes = readString(data.notes) ?? null;
  }

  if (hasOwn(data, 'checklistDone') || hasOwn(data, 'checklist_done')) {
    const checklist = (data.checklistDone ?? data.checklist_done) as string[] | undefined;
    updateData.checklistDone = checklist ?? [];
  }

  if (hasOwn(data, 'lostReason') || hasOwn(data, 'lost_reason')) {
    updateData.lostReason = readString(data.lostReason) ?? readString(data.lost_reason) ?? null;
  }

  if (hasOwn(data, 'lostComment') || hasOwn(data, 'lost_comment')) {
    updateData.lostComment = readString(data.lostComment) ?? readString(data.lost_comment) ?? null;
  }

  if (nextStage && nextStage !== oldStage) {
    const now = new Date();
    updateData.stageEnteredAt = now;
    updateData.wonAt = nextStage === 'won' ? now : null;
    updateData.lostAt = nextStage === 'lost' ? now : null;
  }

  const updated = await prisma.deal.update({
    where: { id },
    data: updateData,
    include: {
      customer: true,
    },
  });

  if (nextStage && nextStage !== oldStage) {
    await prisma.dealActivity.create({
      data: {
        dealId: id,
        type: 'stage.changed',
        content: `${oldStage} -> ${nextStage}`,
        author: authorName,
      },
    });
  } else if (Object.keys(updateData).length > 0) {
    await prisma.dealActivity.create({
      data: {
        dealId: id,
        type: 'deal.updated',
        content: 'Deal updated',
        author: authorName,
      },
    });
  }

  return serializeDealDetail(updated);
}

export async function getActivities(orgId: string, dealId: string) {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, orgId } });
  if (!deal) {
    throw new NotFoundError('Deal', dealId);
  }

  const activities = await prisma.dealActivity.findMany({
    where: { dealId },
    orderBy: { createdAt: 'desc' },
  });

  return {
    count: activities.length,
    results: activities.map((activity) => serializeDealActivity(activity)),
  };
}

export async function addActivity(orgId: string, dealId: string, data: DealActivityInput) {
  const deal = await prisma.deal.findFirst({ where: { id: dealId, orgId } });
  if (!deal) {
    throw new NotFoundError('Deal', dealId);
  }

  const content = extractActivityContent(data);
  if (!content) {
    throw new ValidationError('Activity content is required');
  }

  const activity = await prisma.dealActivity.create({
    data: {
      dealId,
      type: normalizeActivityType(data.type),
      content,
      author: data.author,
    },
  });

  return serializeDealActivity(activity);
}

export async function remove(orgId: string, id: string) {
  const deal = await prisma.deal.findFirst({ where: { id, orgId } });
  if (!deal) {
    throw new NotFoundError('Deal', id);
  }

  await prisma.deal.delete({ where: { id } });
  return { ok: true };
}
