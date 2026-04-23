import { prisma } from '../../lib/prisma.js';

export async function getOverview(orgId: string, dateFrom?: Date, dateTo?: Date) {
  const dateFilter =
    dateFrom || dateTo
      ? {
          createdAt: {
            ...(dateFrom ? { gte: dateFrom } : {}),
            ...(dateTo ? { lte: dateTo } : {}),
          },
        }
      : {};

  const orders = await prisma.chapanOrder.findMany({
    where: { orgId, deletedAt: null, ...dateFilter },
    select: {
      status: true,
      totalAmount: true,
      paidAmount: true,
      managerId: true,
      managerName: true,
      createdAt: true,
    },
  });

  const totalRevenue = orders.reduce((s, o) => s + o.totalAmount, 0);
  const totalPaid = orders.reduce((s, o) => s + o.paidAmount, 0);
  const completed = orders.filter((o) => o.status === 'completed');

  const byStatus: Record<string, number> = {};
  for (const o of orders) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
  }

  const timelineMap = new Map<string, { count: number; revenue: number }>();
  for (const o of orders) {
    const day = o.createdAt.toISOString().slice(0, 10);
    const cur = timelineMap.get(day) ?? { count: 0, revenue: 0 };
    timelineMap.set(day, { count: cur.count + 1, revenue: cur.revenue + o.totalAmount });
  }
  const timeline = [...timelineMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({ date, ...d }));

  const managerMap = new Map<
    string,
    { id: string; name: string; count: number; totalAmount: number; paidAmount: number }
  >();
  for (const o of orders) {
    if (!o.managerId) continue;
    const cur = managerMap.get(o.managerId) ?? {
      id: o.managerId,
      name: o.managerName ?? '—',
      count: 0,
      totalAmount: 0,
      paidAmount: 0,
    };
    managerMap.set(o.managerId, {
      ...cur,
      count: cur.count + 1,
      totalAmount: cur.totalAmount + o.totalAmount,
      paidAmount: cur.paidAmount + o.paidAmount,
    });
  }
  const managers = [...managerMap.values()].sort((a, b) => b.totalAmount - a.totalAmount);

  return {
    period: {
      from: dateFrom?.toISOString() ?? null,
      to: dateTo?.toISOString() ?? null,
      ordersCount: orders.length,
    },
    revenue: {
      total: totalRevenue,
      paid: totalPaid,
      unpaid: totalRevenue - totalPaid,
      completed: completed.reduce((s, o) => s + o.totalAmount, 0),
    },
    orders: {
      total: orders.length,
      byStatus,
      avgAmount: orders.length > 0 ? totalRevenue / orders.length : 0,
      completionRate: orders.length > 0 ? (completed.length / orders.length) * 100 : 0,
    },
    timeline,
    managers,
  };
}
