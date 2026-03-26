/**
 * prisma/seed.ts — Demo data seed
 * Reflects the new employee system: employees are added by admins
 * with phone-based login and permission checkboxes.
 *
 * Usage: npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const HASH = await bcrypt.hash('demo1234', 10);
// Phone-based passwords: each employee's password = their phone (hashed)
// They must do phone+phone first-login to set a real password.
async function hashPhone(phone: string) {
  return bcrypt.hash(phone, 10);
}

function ago(days: number, hours = 0): Date {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000);
}
function later(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

async function main() {
  console.log('🌱  Seeding database...');

  // ── OWNER ───────────────────────────────────────────────────────────────
  const owner = await prisma.user.upsert({
    where: { email: 'admin@kort.local' },
    update: {},
    create: {
      id: 'u-owner',
      email: 'admin@kort.local',
      fullName: 'Арман Калиев',
      phone: '+77010000001',
      password: HASH,
      status: 'active',
    },
  });

  // ── ORGANIZATION ─────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { slug: 'demo-company' },
    update: { mode: 'industrial', onboardingCompleted: true },
    create: {
      id: 'org-demo',
      name: 'Demo Company',
      slug: 'demo-company',
      mode: 'industrial',
      onboardingCompleted: true,
      currency: 'KZT',
      industry: 'Производство',
      // Extended profile
      legalForm: 'ТОО',
      legalName: 'Товарищество с ограниченной ответственностью «Demo Company»',
      city: 'Алматы',
      director: 'Арман Калиев',
    },
  });

  // ── OWNER MEMBERSHIP ─────────────────────────────────────────────────────
  await prisma.membership.upsert({
    where: { userId_orgId: { userId: owner.id, orgId: org.id } },
    update: {},
    create: {
      userId: owner.id,
      orgId: org.id,
      role: 'owner',
      status: 'active',
      source: 'company_registration',
      joinedAt: ago(90),
      employeeAccountStatus: 'active',
      department: '',
    },
  });

  // ── CHAPAN PROFILE ────────────────────────────────────────────────────────
  await prisma.chapanProfile.upsert({
    where: { orgId: org.id },
    update: {},
    create: {
      orgId: org.id,
      displayName: 'Чапан Цех',
      descriptor: 'Ателье национальной одежды',
      orderPrefix: 'ЧП',
    },
  });

  // ── EMPLOYEES (phone-based, added by admin) ───────────────────────────────
  const employees: Array<{
    id: string;
    phone: string;
    fullName: string;
    department: string;
    permissions: string[];
    accountStatus: string;
  }> = [
    {
      id: 'u-manager',
      phone: '+77010000002',
      fullName: 'Дана Оспанова',
      department: 'Продажи',
      permissions: ['sales', 'observer'],
      accountStatus: 'active',  // already set password
    },
    {
      id: 'u-finance',
      phone: '+77010000003',
      fullName: 'Нурлан Сериков',
      department: 'Бухгалтерия',
      permissions: ['financial_report'],
      accountStatus: 'pending_first_login', // hasn't logged in yet
    },
    {
      id: 'u-production',
      phone: '+77010000004',
      fullName: 'Айгуль Муканова',
      department: 'Производство',
      permissions: ['production'],
      accountStatus: 'active',
    },
    {
      id: 'u-full',
      phone: '+77010000005',
      fullName: 'Болат Ахметов',
      department: 'Администрация',
      permissions: ['full_access'],
      accountStatus: 'active',
    },
    {
      id: 'u-observer',
      phone: '+77010000006',
      fullName: 'Карина Смагулова',
      department: 'Маркетинг',
      permissions: ['observer'],
      accountStatus: 'active',
    },
    {
      id: 'u-dismissed',
      phone: '+77010000007',
      fullName: 'Асхат Нуров',
      department: 'Продажи',
      permissions: ['sales'],
      accountStatus: 'dismissed', // fired
    },
  ];

  for (const emp of employees) {
    const phoneHash = await hashPhone(emp.phone);

    // Active employees who already have a real password use 'demo1234'
    // pending_first_login employees use their phone as password
    const password = emp.accountStatus === 'active' ? HASH : phoneHash;

    const user = await prisma.user.upsert({
      where: { id: emp.id },
      update: {},
      create: {
        id: emp.id,
        phone: emp.phone,
        fullName: emp.fullName,
        password,
        status: emp.accountStatus === 'dismissed' ? 'inactive' : 'active',
        // No email for phone-only employees
      },
    });

    await prisma.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: org.id } },
      update: {},
      create: {
        userId: user.id,
        orgId: org.id,
        role: 'viewer',
        status: 'active',
        source: 'admin_added',
        joinedAt: ago(30),
        department: emp.department,
        employeePermissions: emp.permissions,
        addedById: owner.id,
        addedByName: owner.fullName,
        employeeAccountStatus: emp.accountStatus,
      },
    });
  }

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────
  const customers = await Promise.all([
    prisma.customer.upsert({
      where: { id: 'cust-1' },
      update: {},
      create: {
        id: 'cust-1',
        orgId: org.id,
        fullName: 'Айдана Бекова',
        phone: '+7 701 555 0101',
        email: 'aidana@example.kz',
        status: 'active',
        source: 'instagram',
        tags: ['VIP'],
      },
    }),
    prisma.customer.upsert({
      where: { id: 'cust-2' },
      update: {},
      create: {
        id: 'cust-2',
        orgId: org.id,
        fullName: 'Марат Исаев',
        phone: '+7 702 555 0202',
        status: 'new',
        source: 'referral',
      },
    }),
    prisma.customer.upsert({
      where: { id: 'cust-3' },
      update: {},
      create: {
        id: 'cust-3',
        orgId: org.id,
        fullName: 'Зарина Досова',
        phone: '+7 777 555 0303',
        email: 'zarina@example.kz',
        companyName: 'ТОО «Алтын»',
        status: 'active',
        source: 'site',
      },
    }),
  ]);

  // ── LEADS ─────────────────────────────────────────────────────────────────
  const leadsData = [
    {
      id: 'lead-1', customerId: customers[0].id,
      fullName: 'Айдана Бекова', phone: '+7 701 555 0101',
      source: 'instagram', stage: 'new', pipeline: 'qualifier',
      assignedTo: 'u-manager', assignedName: 'Дана Оспанова',
    },
    {
      id: 'lead-2', customerId: customers[1].id,
      fullName: 'Марат Исаев', phone: '+7 702 555 0202',
      source: 'referral', stage: 'qualified', pipeline: 'closer',
      budget: 250000, assignedTo: 'u-manager', assignedName: 'Дана Оспанова',
    },
    {
      id: 'lead-3', customerId: null,
      fullName: 'Жанна Смирнова', phone: '+7 778 555 0404',
      source: 'ad', stage: 'new', pipeline: 'qualifier',
    },
  ];

  for (const l of leadsData) {
    await prisma.lead.upsert({
      where: { id: l.id },
      update: {},
      create: {
        id: l.id,
        orgId: org.id,
        customerId: l.customerId ?? undefined,
        fullName: l.fullName,
        phone: l.phone,
        source: l.source,
        stage: l.stage,
        pipeline: l.pipeline,
        assignedTo: l.assignedTo ?? undefined,
        assignedName: l.assignedName ?? undefined,
        budget: (l as any).budget ?? undefined,
        createdAt: ago(7),
      },
    });
  }

  // ── DEALS ─────────────────────────────────────────────────────────────────
  const dealsData = [
    {
      id: 'deal-1', customerId: customers[0].id,
      fullName: 'Айдана Бекова', phone: '+7 701 555 0101',
      title: 'Корпоративный заказ чапанов', stage: 'proposal',
      value: 480000, probability: 60, currency: 'KZT',
      assignedTo: 'u-manager', assignedName: 'Дана Оспанова',
    },
    {
      id: 'deal-2', customerId: customers[2].id,
      fullName: 'Зарина Досова', phone: '+7 777 555 0303',
      title: 'Свадебный комплект', stage: 'awaiting_meeting',
      value: 320000, probability: 40, currency: 'KZT',
    },
    {
      id: 'deal-3', customerId: customers[1].id,
      fullName: 'Марат Исаев', phone: '+7 702 555 0202',
      title: 'Оптовая партия', stage: 'won',
      value: 1200000, probability: 100, currency: 'KZT',
      wonAt: ago(5),
    },
  ];

  for (const d of dealsData) {
    await prisma.deal.upsert({
      where: { id: d.id },
      update: {},
      create: {
        id: d.id,
        orgId: org.id,
        customerId: d.customerId ?? undefined,
        fullName: d.fullName,
        phone: d.phone ?? undefined,
        title: d.title,
        stage: d.stage,
        value: d.value,
        probability: d.probability,
        currency: d.currency,
        assignedTo: (d as any).assignedTo ?? undefined,
        assignedName: (d as any).assignedName ?? undefined,
        wonAt: (d as any).wonAt ?? undefined,
        createdAt: ago(14),
      },
    });
  }

  // ── TASKS ─────────────────────────────────────────────────────────────────
  await prisma.task.upsert({
    where: { id: 'task-1' },
    update: {},
    create: {
      id: 'task-1',
      orgId: org.id,
      dealId: 'deal-1',
      title: 'Согласовать эскизы',
      status: 'todo',
      priority: 'high',
      assignedTo: 'u-manager',
      assignedName: 'Дана Оспанова',
      createdBy: owner.id,
      dueDate: later(3),
    },
  });

  await prisma.task.upsert({
    where: { id: 'task-2' },
    update: {},
    create: {
      id: 'task-2',
      orgId: org.id,
      title: 'Проверить наличие ткани',
      status: 'in_progress',
      priority: 'medium',
      assignedTo: 'u-production',
      assignedName: 'Айгуль Муканова',
      createdBy: owner.id,
      dueDate: later(1),
    },
  });

  // ── CHAPAN: WORKERS ───────────────────────────────────────────────────────
  await prisma.chapanWorker.createMany({
    data: ['Айгуль М.', 'Нурлан К.', 'Гүлнар А.', 'Бакыт С.'].map(name => ({ orgId: org.id, name })),
    skipDuplicates: true,
  });

  // ── CHAPAN: CATALOG ───────────────────────────────────────────────────────
  await prisma.chapanCatalogProduct.createMany({
    data: ['Чапан мужской', 'Чапан женский', 'Камзол', 'Белдемше', 'Саукеле'].map(name => ({ orgId: org.id, name })),
    skipDuplicates: true,
  });
  await prisma.chapanCatalogFabric.createMany({
    data: ['Бархат', 'Атлас', 'Шёлк', 'Парча', 'Трикотаж'].map(name => ({ orgId: org.id, name })),
    skipDuplicates: true,
  });
  await prisma.chapanCatalogSize.createMany({
    data: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '44', '46', '48', '50', '52', '54'].map(name => ({ orgId: org.id, name })),
    skipDuplicates: true,
  });

  // ── CHAPAN: CLIENT & ORDER ────────────────────────────────────────────────
  const chapanClient = await prisma.chapanClient.upsert({
    where: { id: 'chapan-client-1' },
    update: {},
    create: {
      id: 'chapan-client-1',
      orgId: org.id,
      fullName: 'Айдана Бекова',
      phone: '+7 701 555 0101',
    },
  });

  await prisma.chapanOrder.upsert({
    where: { id: 'chapan-order-1' },
    update: {},
    create: {
      id: 'chapan-order-1',
      orgId: org.id,
      orderNumber: 'ЧП-001',
      clientId: chapanClient.id,
      clientName: chapanClient.fullName,
      clientPhone: chapanClient.phone,
      status: 'in_production',
      paymentStatus: 'partial',
      priority: 'normal',
      totalAmount: 85000,
      paidAmount: 40000,
      dueDate: later(14),
    },
  });

  console.log('✅  Seed complete!');
  console.log('');
  console.log('  Owner login:');
  console.log('    Email:    admin@kort.local');
  console.log('    Password: demo1234');
  console.log('');
  console.log('  Employee logins (phone-based):');
  console.log('    +77010000002 / demo1234   (Продажи — active)');
  console.log('    +77010000003 / phone      (Бухгалтерия — pending_first_login, phone+phone required)');
  console.log('    +77010000004 / demo1234   (Производство — active)');
  console.log('    +77010000005 / demo1234   (Полный доступ — active)');
  console.log('    +77010000006 / demo1234   (Наблюдатель — active)');
  console.log('    +77010000007 / blocked    (Уволен — login blocked)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
