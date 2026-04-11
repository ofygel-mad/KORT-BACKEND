import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disconnectDatabase, prisma } from '../../../lib/prisma.js';
import {
  addPayment,
  close,
  confirm,
  create,
  fulfillFromStock,
  getById,
  list,
  routeSingleItem,
  restore,
  updateStatus,
} from '../orders.service.js';
import { moveStatus } from '../production.service.js';

vi.mock('../sheets.sync.js', () => ({
  syncOrderToSheets: vi.fn().mockResolvedValue({ ok: true }),
}));

type TestContext = {
  orgId: string;
  authorId: string;
  authorName: string;
};

async function createTestContext(): Promise<TestContext> {
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const org = await prisma.organization.create({
    data: {
      name: `Integration Org ${token}`,
      slug: `integration-org-${token}`,
      chapanProfile: {
        create: {
          displayName: 'Integration Workshop',
          orderPrefix: 'INT',
        },
      },
    },
  });

  return {
    orgId: org.id,
    authorId: `author-${token}`,
    authorName: 'Integration Manager',
  };
}

async function createOrderForContext(context: TestContext, overrides?: {
  prepayment?: number;
  paymentMethod?: string;
  paymentBreakdown?: Record<string, number>;
}) {
  return create(context.orgId, context.authorId, context.authorName, {
    clientName: '  аЙгҮл   нұр-сұлтан  ',
    clientPhone: '8 701 555 44 33',
    priority: 'urgent',
    prepayment: overrides?.prepayment ?? 0,
    paymentMethod: overrides?.paymentMethod ?? 'cash',
    paymentBreakdown: overrides?.paymentBreakdown,
    items: [
      {
        productName: 'Chapan Premium',
        fabric: 'Cotton',
        size: 'M',
        quantity: 2,
        unitPrice: 12000,
        workshopNotes: 'Test workshop note',
      },
      {
        productName: 'Vest',
        size: 'L',
        quantity: 1,
        unitPrice: 8000,
      },
    ],
  });
}

describe('Orders Service Integration Tests', () => {
  let context: TestContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    context = await createTestContext();
  });

  afterEach(async () => {
    await prisma.organization.deleteMany({
      where: { id: context.orgId },
    });
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('creates an order with normalized client data, payments, and activity trail', async () => {
    const order = await createOrderForContext(context, {
      prepayment: 5000,
      paymentMethod: 'mixed',
      paymentBreakdown: {
        cash: 3000,
        transfer: 2000,
        kaspi_qr: 0,
      },
    });

    expect(order.orderNumber).toBe('INT-001');
    expect(order.clientName).toBe('Айгүл Нұр-Сұлтан');
    expect(order.clientPhone).toBe('+7 (701)-555-44-33');
    expect(order.totalAmount).toBe(32000);
    expect(order.paidAmount).toBe(5000);
    expect(order.paymentStatus).toBe('partial');
    expect(order.urgency).toBe('urgent');
    expect(order.items).toHaveLength(2);
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]?.method).toBe('mixed');
    expect(order.activities.length).toBeGreaterThanOrEqual(2);

    const client = await prisma.chapanClient.findUnique({
      where: { id: order.clientId },
    });

    expect(client?.fullName).toBe('Айгүл Нұр-Сұлтан');
    expect(client?.phone).toBe('+7 (701)-555-44-33');
  });

  it('lists and fetches orders for the current organization only', async () => {
    const order = await createOrderForContext(context);

    const orders = await list(context.orgId, {
      search: 'Premium',
      statuses: ['new'],
    });

    expect(orders).toHaveLength(1);
    expect(orders[0]?.id).toBe(order.id);

    const fetched = await getById(context.orgId, order.id);
    expect(fetched.id).toBe(order.id);
    expect(fetched.items.map((item) => item.productName)).toEqual(['Chapan Premium', 'Vest']);
  });

  it('confirm routes all items into production and creates production tasks', async () => {
    const created = await createOrderForContext(context);

    const confirmed = await confirm(context.orgId, created.id, context.authorId, context.authorName);

    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.items.every((item) => item.fulfillmentMode === 'production')).toBe(true);
    expect(confirmed.productionTasks).toHaveLength(2);
    expect(confirmed.productionTasks.every((task) => task.status === 'queued')).toBe(true);
  });

  it('fulfillFromStock skips production and moves the order directly to ready', async () => {
    const created = await createOrderForContext(context);

    const ready = await fulfillFromStock(context.orgId, created.id, context.authorId, context.authorName);

    expect(ready.status).toBe('ready');
    expect(ready.items.every((item) => item.fulfillmentMode === 'warehouse')).toBe(true);
    expect(ready.productionTasks).toHaveLength(0);
  });

  it('keeps the order in routing flow when only one item is marked ready', async () => {
    const created = await createOrderForContext(context);
    const firstItem = created.items[0];
    const secondItem = created.items[1];

    expect(firstItem).toBeDefined();
    expect(secondItem).toBeDefined();

    await routeSingleItem(context.orgId, created.id, firstItem!.id, 'warehouse', context.authorId, context.authorName);

    const partiallyRouted = await getById(context.orgId, created.id);
    expect(partiallyRouted.status).toBe('confirmed');
    expect(partiallyRouted.items.find((item) => item.id === firstItem!.id)?.fulfillmentMode).toBe('warehouse');
    expect(partiallyRouted.items.find((item) => item.id === secondItem!.id)?.fulfillmentMode).toBe('unassigned');

    const activityCount = partiallyRouted.activities.length;
    await routeSingleItem(context.orgId, created.id, firstItem!.id, 'warehouse', context.authorId, context.authorName);

    const afterRepeat = await getById(context.orgId, created.id);
    expect(afterRepeat.activities).toHaveLength(activityCount);
  });

  it('does not move the whole order to ready when production is finished but other items are still unassigned', async () => {
    const created = await createOrderForContext(context);
    const firstItem = created.items[0];

    expect(firstItem).toBeDefined();

    await routeSingleItem(context.orgId, created.id, firstItem!.id, 'production', context.authorId, context.authorName);

    const routed = await getById(context.orgId, created.id);
    const task = routed.productionTasks.find((entry) => entry.orderItemId === firstItem!.id);

    expect(task).toBeDefined();

    await moveStatus(context.orgId, task!.id, 'done', context.authorId, context.authorName);

    const afterProduction = await getById(context.orgId, created.id);
    expect(afterProduction.status).toBe('confirmed');
    expect(afterProduction.items.filter((item) => item.fulfillmentMode === 'unassigned')).toHaveLength(1);
  });

  it('blocks ready status until production tasks are completed', async () => {
    const created = await createOrderForContext(context);
    const confirmed = await confirm(context.orgId, created.id, context.authorId, context.authorName);

    // First transition from confirmed to in_production
    await updateStatus(
      context.orgId,
      confirmed.id,
      'in_production',
      context.authorId,
      context.authorName,
    );
    const inProduction = await getById(context.orgId, confirmed.id);
    expect(inProduction.status).toBe('in_production');

    // Try to move to ready without completing production tasks - should fail
    await expect(
      updateStatus(context.orgId, inProduction.id, 'ready', context.authorId, context.authorName),
    ).rejects.toThrow();

    // Complete production tasks
    await prisma.chapanProductionTask.updateMany({
      where: { orderId: inProduction.id },
      data: { status: 'done' },
    });

    // Now should be able to move to ready
    await updateStatus(context.orgId, inProduction.id, 'ready', context.authorId, context.authorName);

    const ready = await getById(context.orgId, inProduction.id);
    expect(ready.status).toBe('ready');
  });

  it('adds payments, updates payment status, and resolves open unpaid alerts', async () => {
    const created = await createOrderForContext(context);

    await prisma.chapanUnpaidAlert.create({
      data: {
        orgId: context.orgId,
        orderId: created.id,
        orderNumber: created.orderNumber,
        createdBy: context.authorId,
      },
    });

    await addPayment(context.orgId, created.id, context.authorId, context.authorName, {
      amount: 12000,
      method: 'cash',
    });

    const secondPayment = await addPayment(
      context.orgId,
      created.id,
      context.authorId,
      context.authorName,
      {
        amount: 20000,
        method: 'transfer',
      },
    );

    expect(secondPayment.method).toBe('transfer');

    const paidOrder = await getById(context.orgId, created.id);
    expect(paidOrder.paidAmount).toBe(32000);
    expect(paidOrder.paymentStatus).toBe('paid');

    const alert = await prisma.chapanUnpaidAlert.findFirst({
      where: { orderId: created.id },
    });
    expect(alert?.resolvedAt).not.toBeNull();
    expect(alert?.resolvedBy).toBe(context.authorId);
  });

  it('closes a ready order into the archive and restores it back to new', async () => {
    const created = await createOrderForContext(context);

    await fulfillFromStock(context.orgId, created.id, context.authorId, context.authorName);
    await addPayment(context.orgId, created.id, context.authorId, context.authorName, {
      amount: 32000,
      method: 'transfer',
    });
    await close(context.orgId, created.id, context.authorId, context.authorName);

    const archived = await getById(context.orgId, created.id);
    expect(archived.status).toBe('completed');
    expect(archived.isArchived).toBe(true);
    expect(archived.archivedAt).not.toBeNull();

    await restore(context.orgId, created.id, context.authorId, context.authorName);

    const restored = await getById(context.orgId, created.id);
    expect(restored.status).toBe('new');
    expect(restored.isArchived).toBe(false);
    expect(restored.archivedAt).toBeNull();
  });
});
