import { NotFoundError } from '../../lib/errors.js';
import { paginate, paginatedResponse, type PaginationParams } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import {
  listCustomerActivities,
  listCustomerRelatedDeals,
  listCustomerRelatedTasks,
} from '../frontend-compat/frontend-compat.service.js';
import { serializeCustomer } from '../frontend-compat/crm-compat.js';

function buildOwner(id: string | null | undefined, fullName: string | null | undefined) {
  if (!id && !fullName) {
    return null;
  }

  return {
    id: id ?? `owner:${(fullName ?? 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'user'}`,
    full_name: fullName ?? 'Unknown user',
  };
}

function serializeCustomerDetail(
  customer: {
    id: string;
    fullName: string;
    companyName: string | null;
    phone: string | null;
    email: string | null;
    status: string;
    source: string | null;
    notes: string | null;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
    latestDeal?: {
      source: string | null;
      assignedTo: string | null;
      assignedName: string | null;
    } | null;
  },
) {
  const base = serializeCustomer({
    id: customer.id,
    orgId: '',
    fullName: customer.fullName,
    phone: customer.phone,
    email: customer.email,
    companyName: customer.companyName,
    status: customer.status,
    source: customer.source,
    notes: customer.notes,
    tags: customer.tags,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  });

  return {
    ...base,
    source: customer.latestDeal?.source ?? 'manual',
    owner: buildOwner(customer.latestDeal?.assignedTo, customer.latestDeal?.assignedName),
  };
}

export async function list(orgId: string, params: PaginationParams) {
  const where = { orgId };
  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      ...paginate(params),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.customer.count({ where }),
  ]);

  return paginatedResponse(items.map((item) => serializeCustomer(item)), total, params);
}

export async function getById(orgId: string, id: string) {
  const customer = await prisma.customer.findFirst({
    where: { id, orgId },
    include: {
      deals: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: {
          source: true,
          assignedTo: true,
          assignedName: true,
        },
      },
    },
  });

  if (!customer) {
    throw new NotFoundError('Customer', id);
  }

  return serializeCustomerDetail({
    ...customer,
    latestDeal: customer.deals[0] ?? null,
  });
}

export async function create(orgId: string, data: {
  full_name: string;
  phone?: string;
  email?: string;
  company_name?: string;
  notes?: string;
  tags?: string[];
  source?: string;
}) {
  const customer = await prisma.customer.create({
    data: {
      orgId,
      fullName: data.full_name,
      phone: data.phone,
      email: data.email,
      companyName: data.company_name,
      notes: data.notes,
      tags: data.tags ?? [],
      source: data.source ?? 'manual',
    },
  });

  return serializeCustomer(customer);
}

export async function update(orgId: string, id: string, data: Record<string, unknown>) {
  const existing = await prisma.customer.findFirst({ where: { id, orgId } });
  if (!existing) {
    throw new NotFoundError('Customer', id);
  }

  const customer = await prisma.customer.update({
    where: { id },
    data: {
      fullName: data.full_name as string | undefined,
      phone: data.phone as string | undefined,
      email: data.email as string | undefined,
      companyName: data.company_name as string | undefined,
      notes: data.notes as string | undefined,
      tags: data.tags as string[] | undefined,
      status: data.status as string | undefined,
    },
  });

  return serializeCustomer(customer);
}

export async function getActivities(orgId: string, id: string) {
  return listCustomerActivities(orgId, id);
}

export async function getDeals(orgId: string, id: string) {
  return listCustomerRelatedDeals(orgId, id);
}

export async function getTasks(orgId: string, id: string) {
  return listCustomerRelatedTasks(orgId, id);
}
