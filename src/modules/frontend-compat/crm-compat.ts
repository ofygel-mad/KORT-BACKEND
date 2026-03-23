import type { Customer, Deal, DealActivity, Task } from '@prisma/client';

export type DealStageMeta = {
  id: string;
  name: string;
  position: number;
  type: string;
  stage_type: string;
  color: string;
};

export type DealWithCustomer = Deal & {
  customer: Customer | null;
};

export type TaskWithDealCustomer = Task & {
  deal: DealWithCustomer | null;
};

const DEFAULT_PIPELINE_ID = 'default-deal-pipeline';
const DEFAULT_PIPELINE_NAME = 'Main pipeline';

export const DEAL_STAGES: readonly DealStageMeta[] = [
  { id: 'awaiting_meeting', name: 'Awaiting meeting', position: 1, type: 'open', stage_type: 'open', color: '#3b82f6' },
  { id: 'meeting_done', name: 'Meeting done', position: 2, type: 'open', stage_type: 'open', color: '#8b5cf6' },
  { id: 'proposal', name: 'Proposal', position: 3, type: 'open', stage_type: 'open', color: '#f59e0b' },
  { id: 'contract', name: 'Contract', position: 4, type: 'open', stage_type: 'open', color: '#ec4899' },
  { id: 'awaiting_payment', name: 'Awaiting payment', position: 5, type: 'open', stage_type: 'open', color: '#f97316' },
  { id: 'won', name: 'Won', position: 6, type: 'won', stage_type: 'won', color: '#10b981' },
  { id: 'lost', name: 'Lost', position: 7, type: 'lost', stage_type: 'lost', color: '#ef4444' },
];

function toIso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'user';
}

type Person = {
  id: string;
  full_name: string;
};

function buildPerson(id: string | null | undefined, fullName: string | null | undefined): Person | null {
  if (!id && !fullName) {
    return null;
  }

  return {
    id: id ?? `person:${slugify(fullName ?? 'user')}`,
    full_name: fullName ?? 'Unknown user',
  };
}

export function getDealStatus(stage: string | null | undefined): 'open' | 'won' | 'lost' {
  if (stage === 'won') {
    return 'won';
  }

  if (stage === 'lost') {
    return 'lost';
  }

  return 'open';
}

export function getDealStageMeta(stage: string | null | undefined): DealStageMeta {
  return (
    DEAL_STAGES.find((item) => item.id === stage) ?? {
      id: 'awaiting_meeting',
      name: 'Awaiting meeting',
      position: 1,
      type: 'open',
      stage_type: 'open',
      color: '#3b82f6',
    }
  );
}

export function getDealPipeline() {
  return {
    id: DEFAULT_PIPELINE_ID,
    name: DEFAULT_PIPELINE_NAME,
    is_default: true,
    stages: DEAL_STAGES.map((stage) => ({ ...stage })),
  };
}

export function serializeCustomer(customer: Customer) {
  const createdAt = customer.createdAt.toISOString();
  const updatedAt = customer.updatedAt.toISOString();

  return {
    id: customer.id,
    full_name: customer.fullName,
    fullName: customer.fullName,
    company_name: customer.companyName ?? '',
    companyName: customer.companyName ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    status: customer.status,
    source: customer.source ?? 'manual',
    owner: null,
    tags: customer.tags,
    notes: customer.notes ?? '',
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
    last_contact_at: null,
    follow_up_due_at: null,
    response_state: null,
    next_action_note: '',
  };
}

export function serializeDealSummary(deal: DealWithCustomer) {
  const stage = getDealStageMeta(deal.stage);
  const createdAt = deal.createdAt.toISOString();
  const updatedAt = deal.updatedAt.toISOString();
  const customerRef = deal.customer
    ? {
        id: deal.customer.id,
        full_name: deal.customer.fullName,
      }
    : deal.customerId
      ? {
          id: deal.customerId,
          full_name: deal.fullName,
        }
      : null;
  const owner = buildPerson(deal.assignedTo, deal.assignedName);

  return {
    id: deal.id,
    title: deal.title,
    amount: deal.value,
    value: deal.value,
    currency: deal.currency,
    status: getDealStatus(deal.stage),
    stage,
    stage_id: stage.id,
    stage_name: stage.name,
    customer: customerRef,
    customer_id: deal.customerId,
    customer_name: customerRef?.full_name ?? deal.fullName,
    full_name: deal.fullName,
    company_name: deal.companyName ?? '',
    owner,
    owner_name: owner?.full_name ?? null,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
    expected_close_date: toIso(deal.expectedCloseAt),
    expectedCloseAt: toIso(deal.expectedCloseAt),
  };
}

export function serializeDealDetail(deal: DealWithCustomer) {
  const summary = serializeDealSummary(deal);
  const customer = deal.customer
    ? {
        id: deal.customer.id,
        full_name: deal.customer.fullName,
        company_name: deal.customer.companyName ?? '',
        phone: deal.customer.phone ?? '',
        email: deal.customer.email ?? '',
      }
    : deal.customerId
      ? {
          id: deal.customerId,
          full_name: deal.fullName,
          company_name: deal.companyName ?? '',
          phone: deal.phone ?? '',
          email: deal.email ?? '',
        }
      : null;

  return {
    ...summary,
    customer,
    pipeline: getDealPipeline(),
    next_step: '',
    notes: deal.notes ?? '',
  };
}

export function serializeDealBoardItem(deal: Deal) {
  const stage = getDealStageMeta(deal.stage);

  return {
    id: deal.id,
    title: deal.title,
    stage: deal.stage,
    stage_id: stage.id,
    stage_name: stage.name,
    stage_meta: stage,
    status: getDealStatus(deal.stage),
    amount: deal.value,
    value: deal.value,
    currency: deal.currency,
    full_name: deal.fullName,
    customer_name: deal.fullName,
    customer_id: deal.customerId,
    assigned_name: deal.assignedName,
    created_at: deal.createdAt.toISOString(),
    updated_at: deal.updatedAt.toISOString(),
  };
}

function normalizeDealActivityType(type: string): string {
  switch (type) {
    case 'note':
    case 'note.created':
      return 'note.created';
    case 'stage_change':
    case 'stage.changed':
      return 'stage.changed';
    case 'task_created':
    case 'task.created':
      return 'task.created';
    case 'deal_updated':
    case 'deal.updated':
      return 'deal.updated';
    default:
      return type;
  }
}

function buildDealActivityPayload(type: string, content: string) {
  if (type === 'stage.changed') {
    const match = content.match(/^(.*?)\s*(?:->|\u2192)\s*(.*?)$/);
    if (match) {
      return {
        from: match[1]?.trim() ?? '',
        to: match[2]?.trim() ?? '',
        body: content,
      };
    }
  }

  if (type === 'task.created') {
    return {
      title: content,
      body: content,
    };
  }

  return {
    body: content,
  };
}

export function serializeDealActivity(activity: DealActivity) {
  const type = normalizeDealActivityType(activity.type);

  return {
    id: activity.id,
    type,
    payload: buildDealActivityPayload(type, activity.content),
    actor: activity.author ? { full_name: activity.author } : null,
    created_at: activity.createdAt.toISOString(),
  };
}

export function normalizeTaskStatus(status: string | null | undefined): 'open' | 'done' | 'cancelled' {
  if (status === 'done') {
    return 'done';
  }

  if (status === 'cancelled') {
    return 'cancelled';
  }

  return 'open';
}

export function normalizeTaskPriority(priority: string | null | undefined): 'high' | 'medium' | 'low' {
  if (priority === 'critical') {
    return 'high';
  }

  if (priority === 'high' || priority === 'medium' || priority === 'low') {
    return priority;
  }

  return 'medium';
}

export function serializeTask(task: TaskWithDealCustomer) {
  const assignedTo = buildPerson(task.assignedTo, task.assignedName);
  const customer = task.deal?.customer
    ? {
        id: task.deal.customer.id,
        full_name: task.deal.customer.fullName,
      }
    : task.linkedEntityType === 'customer' && task.linkedEntityId
      ? {
          id: task.linkedEntityId,
          full_name: task.linkedEntityTitle ?? 'Customer',
        }
      : null;
  const deal = task.deal
    ? {
        id: task.deal.id,
        title: task.deal.title,
      }
    : task.linkedEntityType === 'deal' && task.linkedEntityId
      ? {
          id: task.linkedEntityId,
          title: task.linkedEntityTitle ?? 'Deal',
        }
      : null;
  const dueAt = toIso(task.dueDate);
  const completedAt = toIso(task.completedAt);
  const createdAt = task.createdAt.toISOString();
  const updatedAt = task.updatedAt.toISOString();
  const status = normalizeTaskStatus(task.status);

  return {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    priority: normalizeTaskPriority(task.priority),
    raw_priority: task.priority,
    status,
    workflow_status: task.status,
    due_at: dueAt,
    due_date: dueAt,
    completed_at: completedAt,
    assigned_to: assignedTo,
    assignee: assignedTo,
    customer,
    deal,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
    is_done: status === 'done',
    tags: task.tags,
  };
}
