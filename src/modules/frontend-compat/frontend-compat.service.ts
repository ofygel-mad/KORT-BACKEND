import { prisma } from '../../lib/prisma.js';
import { DEAL_STAGES, getDealPipeline, getDealStageMeta, serializeDealActivity, serializeTask } from './crm-compat.js';

type SummaryParams = {
  dateFrom?: string;
  dateTo?: string;
};

type AuditFilters = {
  search?: string;
  action?: string;
};

type AssistantInput = {
  message: string;
  customer_id?: string;
  deal_id?: string;
  history?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
};

type CustomFieldParams = {
  entityType: 'customer' | 'deal';
  entityId: string;
};

type SearchQuery = {
  q: string;
  limit: number;
  types?: string;
};

const TODAY_TASK_SELECT = {
  id: true,
  title: true,
  priority: true,
  dueDate: true,
  deal: {
    select: {
      customer: {
        select: {
          id: true,
          fullName: true,
        },
      },
    },
  },
};

function getDayBounds(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function getMonthBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end };
}

function diffDays(from: Date) {
  const diffMs = Date.now() - from.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function toDateRange({ dateFrom, dateTo }: SummaryParams) {
  const now = new Date();
  const fallbackStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = dateFrom ? new Date(dateFrom) : fallbackStart;
  const end = dateTo ? new Date(dateTo) : now;

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return {
      start: fallbackStart,
      endExclusive: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1),
    };
  }

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  const endExclusive = new Date(end);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { start, endExclusive };
}

function shiftDate(value: Date, days: number) {
  const shifted = new Date(value);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function toMonthKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function toMonthLabel(key: string) {
  const [yearPart, monthPart] = key.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  return new Date(year, month - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function percentageDelta(current: number, previous: number) {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }

  return Math.round(((current - previous) / previous) * 100);
}

function mapSourceLabel(value: string | null | undefined) {
  return value?.trim() || 'manual';
}

function getRecentMonthKeys(count: number) {
  const keys: string[] = [];
  const cursor = new Date();
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);

  for (let index = count - 1; index >= 0; index -= 1) {
    const point = new Date(cursor);
    point.setMonth(point.getMonth() - index);
    keys.push(toMonthKey(point));
  }

  return keys;
}

function normalizeFeedType(type: string, content: string) {
  switch (type) {
    case 'note':
    case 'note.created':
      return 'note';
    case 'stage_change':
    case 'stage.changed':
      return 'stage_change';
    case 'task_created':
    case 'task.created':
      return 'task_created';
    case 'status_change':
      return content.toLowerCase().includes('done') ? 'task_done' : 'status_change';
    case 'system':
      return content.toLowerCase().includes('created') ? 'deal_created' : 'status_change';
    default:
      return type;
  }
}

function buildTaskFeedType(activity: { type: string; content: string }) {
  if (activity.type === 'system') {
    return 'task_created';
  }

  if (activity.type === 'status_change') {
    return activity.content.toLowerCase().includes('done') ? 'task_done' : 'status_change';
  }

  return activity.type;
}

function buildTaskAuditAction(type: string) {
  if (type === 'system') {
    return 'create';
  }

  if (type === 'status_change' || type === 'assign' || type === 'comment') {
    return 'update';
  }

  return 'update';
}

function buildDealAuditAction(type: string) {
  if (type === 'system') {
    return 'create';
  }

  return 'update';
}

export async function getDashboard(orgId: string) {
  const { start: dayStart, end: dayEnd } = getDayBounds();
  const { start: monthStart, end: monthEnd } = getMonthBounds();

  const [
    customersCount,
    activeDealsCount,
    overdueTasksCount,
    wonRevenue,
    recentCustomers,
    stalledDeals,
    todayTasks,
  ] = await Promise.all([
    prisma.customer.count({ where: { orgId } }),
    prisma.deal.count({
      where: {
        orgId,
        stage: { notIn: ['won', 'lost'] },
      },
    }),
    prisma.task.count({
      where: {
        orgId,
        status: { not: 'done' },
        dueDate: { lt: dayStart },
      },
    }),
    prisma.deal.aggregate({
      where: {
        orgId,
        stage: 'won',
        wonAt: {
          gte: monthStart,
          lt: monthEnd,
        },
      },
      _sum: { value: true },
    }),
    prisma.customer.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.deal.findMany({
      where: {
        orgId,
        stage: { notIn: ['won', 'lost'] },
      },
      orderBy: { updatedAt: 'asc' },
      take: 5,
    }),
    prisma.task.findMany({
      where: {
        orgId,
        dueDate: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 5,
      select: TODAY_TASK_SELECT,
    }),
  ]);

  return {
    customers_count: customersCount,
    active_deals_count: activeDealsCount,
    revenue_month: wonRevenue._sum.value ?? 0,
    tasks_today: todayTasks.length,
    overdue_tasks: overdueTasksCount,
    recent_customers: recentCustomers.map((customer) => ({
      id: customer.id,
      full_name: customer.fullName,
      company_name: customer.companyName ?? '',
      status: customer.status,
    })),
    stalled_deals: stalledDeals.map((deal) => ({
      id: deal.id,
      title: deal.title,
      amount: deal.value,
      stage: deal.stage,
      customer_name: deal.fullName,
      days_silent: diffDays(deal.updatedAt),
    })),
    today_tasks: todayTasks.map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
      due_at: task.dueDate?.toISOString() ?? null,
      customer: task.deal?.customer
        ? {
            id: task.deal.customer.id,
            full_name: task.deal.customer.fullName,
          }
        : null,
    })),
  };
}

export async function getSummary(orgId: string, params: SummaryParams) {
  const { start, endExclusive } = toDateRange(params);
  const periodDays = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
  const previousStart = shiftDate(start, -periodDays);
  const previousEndExclusive = new Date(start);
  const { start: dayStart, end: dayEnd } = getDayBounds();
  const dealWindow = {
    orgId,
    createdAt: {
      gte: start,
      lt: endExclusive,
    },
  };

  const [
    customersCount,
    previousCustomersCount,
    activeDealsCount,
    revenue,
    tasksToday,
    overdueTasks,
    dealsByStageRows,
    customerSources,
    wonDeals,
    leaderboardDeals,
    customersWithDealsRows,
    dealsCount,
    wonCount,
  ] = await Promise.all([
    prisma.customer.count({
      where: {
        orgId,
        createdAt: {
          gte: start,
          lt: endExclusive,
        },
      },
    }),
    prisma.customer.count({
      where: {
        orgId,
        createdAt: {
          gte: previousStart,
          lt: previousEndExclusive,
        },
      },
    }),
    prisma.deal.count({
      where: {
        orgId,
        stage: {
          notIn: ['won', 'lost'],
        },
      },
    }),
    prisma.deal.aggregate({
      where: {
        orgId,
        stage: 'won',
        wonAt: {
          gte: start,
          lt: endExclusive,
        },
      },
      _sum: { value: true },
    }),
    prisma.task.count({
      where: {
        orgId,
        status: { not: 'done' },
        dueDate: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
    }),
    prisma.task.count({
      where: {
        orgId,
        status: { not: 'done' },
        dueDate: { lt: dayStart },
      },
    }),
    prisma.deal.groupBy({
      by: ['stage'],
      where: dealWindow,
      _count: { _all: true },
      _sum: { value: true },
    }),
    prisma.deal.groupBy({
      by: ['source'],
      where: dealWindow,
      _count: { _all: true },
    }),
    prisma.deal.findMany({
      where: {
        orgId,
        stage: 'won',
        wonAt: { not: null },
      },
      select: {
        wonAt: true,
        value: true,
      },
      orderBy: { wonAt: 'asc' },
    }),
    prisma.deal.findMany({
      where: dealWindow,
      select: {
        assignedName: true,
        value: true,
      },
    }),
    prisma.deal.groupBy({
      by: ['customerId'],
      where: {
        ...dealWindow,
        customerId: { not: null },
      },
    }),
    prisma.deal.count({ where: dealWindow }),
    prisma.deal.count({
      where: {
        ...dealWindow,
        stage: 'won',
      },
    }),
  ]);

  const monthKeys = getRecentMonthKeys(6);
  const revenueByMonthMap = new Map<string, { revenue: number; deals: number }>(
    monthKeys.map((key) => [key, { revenue: 0, deals: 0 }]),
  );

  wonDeals.forEach((deal) => {
    if (!deal.wonAt) {
      return;
    }

    const key = toMonthKey(deal.wonAt);
    const bucket = revenueByMonthMap.get(key);

    if (!bucket) {
      return;
    }

    bucket.revenue += deal.value ?? 0;
    bucket.deals += 1;
  });

  const managerMap = new Map<string, { deals: number; revenue: number }>();
  leaderboardDeals.forEach((deal) => {
    const name = deal.assignedName?.trim() || 'Unassigned';
    const bucket = managerMap.get(name) ?? { deals: 0, revenue: 0 };
    bucket.deals += 1;
    bucket.revenue += deal.value ?? 0;
    managerMap.set(name, bucket);
  });

  return {
    customers_count: customersCount,
    customers_delta: percentageDelta(customersCount, previousCustomersCount),
    active_deals_count: activeDealsCount,
    revenue_month: revenue._sum.value ?? 0,
    tasks_today: tasksToday,
    overdue_tasks: overdueTasks,
    deals_by_stage: dealsByStageRows.map((row) => ({
      stage: getDealStageMeta(row.stage).name,
      count: row._count._all,
      amount: row._sum.value ?? 0,
    })),
    customers_by_source: (customerSources.length > 0 ? customerSources : [{ source: null, _count: { _all: customersCount } }]).map(
      (row) => ({
        source: mapSourceLabel(row.source),
        count: row._count._all,
      }),
    ),
    revenue_by_month: monthKeys.map((key) => ({
      month: toMonthLabel(key),
      revenue: revenueByMonthMap.get(key)?.revenue ?? 0,
      deals: revenueByMonthMap.get(key)?.deals ?? 0,
    })),
    manager_leaderboard: [...managerMap.entries()]
      .map(([name, stats]) => ({
        name,
        deals: stats.deals,
        revenue: stats.revenue,
      }))
      .sort((left, right) => right.revenue - left.revenue)
      .slice(0, 5),
    funnel: {
      customers: customersCount,
      with_deals: customersWithDealsRows.length,
      deals: dealsCount,
      won: wonCount,
      conversion_rate: customersCount > 0 ? wonCount / customersCount : 0,
    },
  };
}

export async function listFeed(orgId: string) {
  const [customers, dealActivities, taskActivities] = await Promise.all([
    prisma.customer.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 12,
      select: {
        id: true,
        fullName: true,
        createdAt: true,
      },
    }),
    prisma.dealActivity.findMany({
      where: {
        deal: { orgId },
      },
      orderBy: { createdAt: 'desc' },
      take: 24,
      include: {
        deal: {
          select: {
            id: true,
            title: true,
            customer: {
              select: {
                id: true,
                fullName: true,
              },
            },
          },
        },
      },
    }),
    prisma.taskActivity.findMany({
      where: {
        task: { orgId },
      },
      orderBy: { createdAt: 'desc' },
      take: 24,
      include: {
        task: {
          select: {
            id: true,
            title: true,
            deal: {
              select: {
                id: true,
                title: true,
                customer: {
                  select: {
                    id: true,
                    fullName: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const items = [
    ...customers.map((customer) => ({
      id: `customer:${customer.id}`,
      type: 'customer_created',
      payload: { body: customer.fullName },
      actor: null,
      customer: {
        id: customer.id,
        full_name: customer.fullName,
      },
      deal: null,
      created_at: customer.createdAt.toISOString(),
    })),
    ...dealActivities.map((activity) => ({
      id: `deal-activity:${activity.id}`,
      type: normalizeFeedType(activity.type, activity.content),
      payload: { body: activity.content },
      actor: activity.author ? { id: `actor:${activity.author}`, full_name: activity.author } : null,
      customer: activity.deal.customer
        ? {
            id: activity.deal.customer.id,
            full_name: activity.deal.customer.fullName,
          }
        : null,
      deal: {
        id: activity.deal.id,
        title: activity.deal.title,
      },
      created_at: activity.createdAt.toISOString(),
    })),
    ...taskActivities.map((activity) => ({
      id: `task-activity:${activity.id}`,
      type: buildTaskFeedType(activity),
      payload: { body: activity.content },
      actor: activity.author ? { id: `actor:${activity.author}`, full_name: activity.author } : null,
      customer: activity.task.deal?.customer
        ? {
            id: activity.task.deal.customer.id,
            full_name: activity.task.deal.customer.fullName,
          }
        : null,
      deal: activity.task.deal
        ? {
            id: activity.task.deal.id,
            title: activity.task.deal.title,
          }
        : null,
      created_at: activity.createdAt.toISOString(),
    })),
  ];

  return items
    .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime())
    .slice(0, 50);
}

export async function listAudit(orgId: string, filters: AuditFilters) {
  const [customers, dealActivities, taskActivities] = await Promise.all([
    prisma.customer.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        fullName: true,
        createdAt: true,
      },
    }),
    prisma.dealActivity.findMany({
      where: {
        deal: { orgId },
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        deal: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    }),
    prisma.taskActivity.findMany({
      where: {
        task: { orgId },
      },
      orderBy: { createdAt: 'desc' },
      take: 60,
      include: {
        task: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    }),
  ]);

  const rows = [
    ...customers.map((customer) => ({
      id: `audit:customer:${customer.id}`,
      action: 'create',
      entity_type: 'customer',
      entity_id: customer.id,
      entity_label: customer.fullName,
      actor_name: 'System',
      diff: null,
      ip_address: null,
      created_at: customer.createdAt.toISOString(),
    })),
    ...dealActivities.map((activity) => ({
      id: `audit:deal:${activity.id}`,
      action: buildDealAuditAction(activity.type),
      entity_type: 'deal',
      entity_id: activity.deal.id,
      entity_label: activity.deal.title,
      actor_name: activity.author || 'System',
      diff: null,
      ip_address: null,
      created_at: activity.createdAt.toISOString(),
    })),
    ...taskActivities.map((activity) => ({
      id: `audit:task:${activity.id}`,
      action: buildTaskAuditAction(activity.type),
      entity_type: 'task',
      entity_id: activity.task.id,
      entity_label: activity.task.title,
      actor_name: activity.author || 'System',
      diff: null,
      ip_address: null,
      created_at: activity.createdAt.toISOString(),
    })),
  ].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

  const searchTerm = filters.search?.trim().toLowerCase();
  const filtered = rows.filter((row) => {
    if (filters.action && row.action !== filters.action) {
      return false;
    }

    if (!searchTerm) {
      return true;
    }

    return [row.entity_label, row.entity_type, row.actor_name, row.action].some((value) =>
      value.toLowerCase().includes(searchTerm),
    );
  });

  return {
    count: filtered.length,
    results: filtered.slice(0, 100),
  };
}

export function listPipelines() {
  return [
    {
      ...getDealPipeline(),
      stages: DEAL_STAGES.map((stage) => ({
        id: stage.id,
        name: stage.name,
        position: stage.position,
        stage_type: stage.stage_type,
        color: stage.color,
      })),
    },
  ];
}

export function getExchangeRates() {
  return {
    base: 'KZT',
    date: new Date().toISOString().slice(0, 10),
    rates: {
      KZT: 1,
      USD: 500,
      EUR: 545,
      RUB: 5.4,
    },
  };
}

export async function replyFromAssistant(orgId: string, input: AssistantInput) {
  const [customer, deal] = await Promise.all([
    input.customer_id
      ? prisma.customer.findFirst({
          where: {
            id: input.customer_id,
            orgId,
          },
          select: {
            fullName: true,
            companyName: true,
          },
        })
      : Promise.resolve(null),
    input.deal_id
      ? prisma.deal.findFirst({
          where: {
            id: input.deal_id,
            orgId,
          },
          select: {
            title: true,
            stage: true,
            value: true,
            currency: true,
          },
        })
      : Promise.resolve(null),
  ]);

  const context: string[] = [];
  if (customer) {
    context.push(`Customer: ${customer.fullName}${customer.companyName ? ` (${customer.companyName})` : ''}.`);
  }

  if (deal) {
    context.push(`Deal: ${deal.title}, stage ${getDealStageMeta(deal.stage).name}, amount ${deal.value.toLocaleString('en-US')} ${deal.currency}.`);
  }

  const lowerMessage = input.message.toLowerCase();
  let guidance = 'Keep the next action explicit: owner, deadline, and one concrete outcome.';

  if (lowerMessage.includes('next') || lowerMessage.includes('\u0441\u043b\u0435\u0434')) {
    guidance = 'Best next step: confirm the owner, schedule a date, and capture the commitment in a task or note right away.';
  } else if (lowerMessage.includes('risk') || lowerMessage.includes('\u0440\u0438\u0441\u043a')) {
    guidance = 'Main risks to check: missing owner, no follow-up date, stale stage, and no recent activity on the record.';
  } else if (lowerMessage.includes('summary') || lowerMessage.includes('\u0441\u0432\u043e\u0434\u043a')) {
    guidance = 'Short summary: review the latest activity, confirm current stage, and write the next step in one sentence.';
  }

  return {
    reply: [...context, guidance].join(' ').trim(),
  };
}

export async function getCustomFieldValues(_orgId: string, _params: CustomFieldParams) {
  return {
    schema: [],
    values: {},
  };
}

export async function saveCustomFieldValues(_orgId: string, _params: CustomFieldParams, values: Record<string, unknown>) {
  return {
    schema: [],
    values,
  };
}

export async function searchWorkspace(orgId: string, query: SearchQuery) {
  const types = new Set(
    (query.types ?? 'customer,deal,task')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const contains = query.q.trim();

  const [customers, deals, tasks] = await Promise.all([
    types.has('customer')
      ? prisma.customer.findMany({
          where: {
            orgId,
            OR: [
              { fullName: { contains, mode: 'insensitive' } },
              { companyName: { contains, mode: 'insensitive' } },
              { email: { contains, mode: 'insensitive' } },
            ],
          },
          orderBy: { updatedAt: 'desc' },
          take: query.limit,
        })
      : Promise.resolve([]),
    types.has('deal')
      ? prisma.deal.findMany({
          where: {
            orgId,
            OR: [
              { title: { contains, mode: 'insensitive' } },
              { fullName: { contains, mode: 'insensitive' } },
              { companyName: { contains, mode: 'insensitive' } },
            ],
          },
          include: {
            customer: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: query.limit,
        })
      : Promise.resolve([]),
    types.has('task')
      ? prisma.task.findMany({
          where: {
            orgId,
            OR: [
              { title: { contains, mode: 'insensitive' } },
              { description: { contains, mode: 'insensitive' } },
            ],
          },
          include: {
            deal: {
              include: {
                customer: true,
              },
            },
          },
          orderBy: { updatedAt: 'desc' },
          take: query.limit,
        })
      : Promise.resolve([]),
  ]);

  return {
    results: [
      ...customers.map((customer) => ({
        id: customer.id,
        type: 'customer',
        label: customer.fullName,
        sublabel: customer.companyName ?? customer.email ?? '',
        path: `/customers/${customer.id}`,
        meta: {
          follow_up_due_at: null,
        },
      })),
      ...deals.map((deal) => ({
        id: deal.id,
        type: 'deal',
        label: deal.title,
        sublabel: deal.customer?.fullName ?? deal.fullName,
        path: `/deals/${deal.id}`,
        meta: {
          amount: deal.value,
          currency: deal.currency,
        },
      })),
      ...tasks.map((task) => {
        const serialized = serializeTask(task);
        return {
          id: task.id,
          type: 'task',
          label: task.title,
          sublabel: serialized.customer?.full_name ?? serialized.deal?.title ?? '',
          path: '/tasks',
          meta: {
            priority: serialized.priority,
          },
        };
      }),
    ].slice(0, query.limit),
  };
}

export async function listNotifications() {
  return {
    count: 0,
    results: [],
  };
}

export async function markAllNotificationsRead() {
  return { ok: true };
}

export async function listCustomerRelatedTasks(orgId: string, customerId: string) {
  const tasks = await prisma.task.findMany({
    where: {
      orgId,
      OR: [
        {
          linkedEntityType: 'customer',
          linkedEntityId: customerId,
        },
        {
          deal: {
            customerId,
          },
        },
      ],
    },
    include: {
      deal: {
        include: {
          customer: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return {
    count: tasks.length,
    results: tasks.map((task) => serializeTask(task)),
  };
}

export async function listCustomerRelatedDeals(orgId: string, customerId: string) {
  const deals = await prisma.deal.findMany({
    where: {
      orgId,
      customerId,
    },
    include: {
      customer: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  return {
    count: deals.length,
    results: deals.map((deal) => ({
      ...serializeDealActivityLikeSummary(deal),
      stage: {
        name: getDealStageMeta(deal.stage).name,
        type: getDealStageMeta(deal.stage).type,
      },
    })),
  };
}

function serializeDealActivityLikeSummary(deal: {
  id: string;
  title: string;
  value: number;
  currency: string;
  stage: string;
  createdAt: Date;
}) {
  return {
    id: deal.id,
    title: deal.title,
    amount: deal.value,
    currency: deal.currency,
    status: deal.stage === 'won' ? 'won' : deal.stage === 'lost' ? 'lost' : 'open',
    created_at: deal.createdAt.toISOString(),
  };
}

export async function listCustomerActivities(orgId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      orgId,
    },
    select: {
      id: true,
      fullName: true,
      createdAt: true,
    },
  });

  if (!customer) {
    return {
      count: 0,
      results: [],
    };
  }

  const [dealActivities, taskActivities] = await Promise.all([
    prisma.dealActivity.findMany({
      where: {
        deal: {
          orgId,
          customerId,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.taskActivity.findMany({
      where: {
        task: {
          orgId,
          OR: [
            {
              linkedEntityType: 'customer',
              linkedEntityId: customerId,
            },
            {
              deal: {
                customerId,
              },
            },
          ],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const results = [
    {
      id: `customer:${customer.id}:created`,
      type: 'note',
      payload: {
        body: `Customer ${customer.fullName} was created`,
      },
      actor: null,
      created_at: customer.createdAt.toISOString(),
    },
    ...dealActivities.map((activity) => serializeDealActivity(activity)),
    ...taskActivities.map((activity) => ({
      id: activity.id,
      type: 'note',
      payload: {
        body: activity.content,
      },
      actor: activity.author ? { full_name: activity.author } : null,
      created_at: activity.createdAt.toISOString(),
    })),
  ].sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());

  return {
    count: results.length,
    results,
  };
}

// ── SSE entity change detection ───────────────────────────────────────────────

export type EntityCursors = Record<string, Date>;

// Per-org cache of raw aggregate timestamps so concurrent SSE connections from
// the same org share one DB round-trip instead of each running 8 queries.
const _timestampCache = new Map<string, { ts: Record<string, Date | null>; expiresAt: number }>();
const _CACHE_TTL_MS = 12_000;

export async function detectEntityChanges(
  orgId: string,
  cursors: EntityCursors,
): Promise<string[]> {
  // ChapanProductionTask has no orgId — covered via chapan_orders invalidation on frontend
  const checks: Array<{ key: string; fn: () => Promise<Date | null> }> = [
    {
      key: 'chapan_orders',
      fn: async () => (await prisma.chapanOrder.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'chapan_invoices',
      fn: async () => (await prisma.chapanInvoice.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'chapan_returns',
      fn: async () => (await prisma.chapanReturn.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'leads',
      fn: async () => (await prisma.lead.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'deals',
      fn: async () => (await prisma.deal.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'customers',
      fn: async () => (await prisma.customer.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'tasks',
      fn: async () => (await prisma.task.aggregate({ where: { orgId }, _max: { updatedAt: true } }))._max.updatedAt,
    },
    {
      key: 'finance',
      fn: async () => (await prisma.accountingEntry.aggregate({ where: { orgId }, _max: { createdAt: true } }))._max.createdAt,
    },
  ];

  const now = Date.now();
  let timestamps: Record<string, Date | null>;

  const cached = _timestampCache.get(orgId);
  if (cached && cached.expiresAt > now) {
    timestamps = cached.ts;
  } else {
    const results = await Promise.allSettled(checks.map((c) => c.fn()));
    timestamps = {};
    results.forEach((result, i) => {
      const key = checks[i]?.key;
      if (key) timestamps[key] = result.status === 'fulfilled' ? result.value : null;
    });
    _timestampCache.set(orgId, { ts: timestamps, expiresAt: now + _CACHE_TTL_MS });
  }

  const changed: string[] = [];
  for (const check of checks) {
    const latest = timestamps[check.key];
    if (!latest) continue;
    const prev = cursors[check.key];
    if (!prev || latest > prev) {
      changed.push(check.key);
      cursors[check.key] = latest;
    }
  }

  return changed;
}
