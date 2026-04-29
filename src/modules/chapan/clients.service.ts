import { prisma } from '../../lib/prisma.js';
import { NotFoundError } from '../../lib/errors.js';
import { Prisma } from '@prisma/client';

interface AggregatedClientRow {
  id: string;
  orgId: string;
  fullName: string;
  phone: string;
  email: string | null;
  company: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  crmCustomerId: string | null;
  orderCount: number;
  totalSpent: number;
  totalPaid: number;
  lastOrderAt: string | null;
  retailOrderCount: number;
  wholesaleOrderCount: number;
}

interface ListClientsOpts {
  search?: string;
  customerType: 'retail' | 'wholesale' | 'all';
  sortBy: 'name' | 'orders' | 'spent' | 'lastOrder';
  limit: number;
  offset: number;
}

function sortClause(sortBy: string): Prisma.Sql {
  switch (sortBy) {
    case 'name':
      return Prisma.sql`c.full_name ASC`;
    case 'orders':
      return Prisma.sql`"orderCount" DESC`;
    case 'spent':
      return Prisma.sql`"totalSpent" DESC`;
    case 'lastOrder':
      return Prisma.sql`"lastOrderAt" DESC NULLS LAST`;
    default:
      return Prisma.sql`"lastOrderAt" DESC NULLS LAST`;
  }
}

export async function listClients(
  orgId: string,
  opts: ListClientsOpts
): Promise<{ count: number; results: AggregatedClientRow[] }> {
  const whereClause =
    opts.customerType === 'retail'
      ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM chapan_orders x
          WHERE x.client_id = c.id AND x.org_id = ${orgId}
            AND x.customer_type = 'retail' AND x.deleted_at IS NULL
        )`
      : opts.customerType === 'wholesale'
        ? Prisma.sql`AND EXISTS (
          SELECT 1 FROM chapan_orders x
          WHERE x.client_id = c.id AND x.org_id = ${orgId}
            AND x.customer_type = 'wholesale' AND x.deleted_at IS NULL
        )`
        : Prisma.empty;

  const searchClause = opts.search
    ? Prisma.sql`AND (
        c.full_name ILIKE ${'%' + opts.search + '%'}
        OR c.phone ILIKE ${'%' + opts.search + '%'}
        OR c.company ILIKE ${'%' + opts.search + '%'}
      )`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<AggregatedClientRow[]>`
    SELECT
      c.id,
      c.org_id            AS "orgId",
      c.full_name         AS "fullName",
      c.phone,
      c.email,
      c.company,
      c.notes,
      c.created_at        AS "createdAt",
      c.updated_at        AS "updatedAt",
      c.crm_customer_id   AS "crmCustomerId",
      COUNT(o.id)::int                                               AS "orderCount",
      COALESCE(SUM(o.total_amount), 0)::int                          AS "totalSpent",
      COALESCE(SUM(o.paid_amount), 0)::int                           AS "totalPaid",
      MAX(o.created_at)                                              AS "lastOrderAt",
      COUNT(o.id) FILTER (WHERE o.customer_type = 'retail')::int     AS "retailOrderCount",
      COUNT(o.id) FILTER (WHERE o.customer_type = 'wholesale')::int  AS "wholesaleOrderCount"
    FROM chapan_clients c
    LEFT JOIN chapan_orders o
      ON o.client_id = c.id
      AND o.org_id   = ${orgId}
      AND o.deleted_at IS NULL
    WHERE c.org_id = ${orgId}
      ${searchClause}
      ${whereClause}
    GROUP BY c.id
    ORDER BY ${sortClause(opts.sortBy)}
    LIMIT ${opts.limit} OFFSET ${opts.offset}
  `;

  const [{ count }] = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(DISTINCT c.id)::bigint as count
    FROM chapan_clients c
    LEFT JOIN chapan_orders o
      ON o.client_id = c.id
      AND o.org_id   = ${orgId}
      AND o.deleted_at IS NULL
    WHERE c.org_id = ${orgId}
      ${searchClause}
      ${whereClause}
  `;

  return { count: Number(count), results: rows };
}

export async function getClientDetail(orgId: string, clientId: string) {
  const client = await prisma.chapanClient.findFirst({
    where: { id: clientId, orgId },
  });

  if (!client) {
    throw new NotFoundError('ChapanClient');
  }

  const orders = await prisma.chapanOrder.findMany({
    where: { clientId, orgId, deletedAt: null },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalAmount: true,
      paidAmount: true,
      customerType: true,
      createdAt: true,
      items: {
        select: {
          productName: true,
          quantity: true,
          unitPrice: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const totalSpent = orders.reduce((s, o) => s + o.totalAmount, 0);
  const totalPaid = orders.reduce((s, o) => s + o.paidAmount, 0);
  const retailOrders = orders.filter((o) => o.customerType === 'retail')
    .length;
  const wholesaleOrders = orders.filter((o) => o.customerType === 'wholesale')
    .length;

  return {
    ...client,
    stats: {
      orderCount: orders.length,
      totalSpent,
      totalPaid,
      retailOrders,
      wholesaleOrders,
    },
    orders,
  };
}

export async function updateClient(
  orgId: string,
  clientId: string,
  data: {
    fullName?: string;
    phone?: string;
    email?: string | null;
    company?: string | null;
    notes?: string | null;
  }
) {
  const client = await prisma.chapanClient.findFirst({
    where: { id: clientId, orgId },
  });

  if (!client) {
    throw new NotFoundError('ChapanClient');
  }

  const updated = await prisma.chapanClient.update({
    where: { id: clientId },
    data: {
      fullName: data.fullName,
      phone: data.phone,
      email: data.email,
      company: data.company,
      notes: data.notes,
    },
  });

  return updated;
}
