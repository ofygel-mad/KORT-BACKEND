import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const OWNER_EMAIL = 'admin@kort.local';
const OWNER_PHONE = '+77010000001';
const OWNER_ID = 'u-owner';
const EMPLOYEE_PHONE = '+77010000003';
const EMPLOYEE_ID = 'u-employee-pending';
const ORG_ID = 'org-demo';
const ORG_SLUG = 'demo-company';
const CUSTOMER_ID = 'cust-aidana';

const OWNER_PASSWORD = await bcrypt.hash('demo1234', 10);
const EMPLOYEE_PASSWORD = await bcrypt.hash(EMPLOYEE_PHONE, 10);

function ago(days: number, hours = 0): Date {
  return new Date(Date.now() - days * 86_400_000 - hours * 3_600_000);
}

type SeedUserInput = {
  id: string;
  email?: string | null;
  phone?: string | null;
  fullName: string;
  password: string;
  status: string;
};

async function upsertSeedUser(data: SeedUserInput) {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [
        { id: data.id },
        ...(data.email ? [{ email: data.email }] : []),
        ...(data.phone ? [{ phone: data.phone }] : []),
      ],
    },
  });

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        email: data.email ?? null,
        phone: data.phone ?? null,
        fullName: data.fullName,
        password: data.password,
        status: data.status,
      },
    });
  }

  return prisma.user.create({ data });
}

async function upsertSeedOrganization() {
  const existing = await prisma.organization.findFirst({
    where: {
      OR: [
        { id: ORG_ID },
        { slug: ORG_SLUG },
      ],
    },
  });

  const data = {
    name: 'Demo Company',
    slug: ORG_SLUG,
    mode: 'industrial',
    onboardingCompleted: true,
    currency: 'KZT',
    industry: 'Производство',
    legalForm: 'ТОО',
    legalName: 'Товарищество с ограниченной ответственностью «Demo Company»',
    city: 'Алматы',
    director: 'Арман Калиев',
  } as const;

  if (existing) {
    return prisma.organization.update({
      where: { id: existing.id },
      data,
    });
  }

  return prisma.organization.create({
    data: {
      id: ORG_ID,
      ...data,
    },
  });
}

async function main() {
  console.log('Seeding database...');

  const owner = await upsertSeedUser({
    id: OWNER_ID,
    email: OWNER_EMAIL,
    phone: OWNER_PHONE,
    fullName: 'Арман Калиев',
    password: OWNER_PASSWORD,
    status: 'active',
  });

  const org = await upsertSeedOrganization();

  await prisma.membership.upsert({
    where: { userId_orgId: { userId: owner.id, orgId: org.id } },
    update: {
      role: 'owner',
      status: 'active',
      source: 'company_registration',
      joinedAt: ago(90),
      employeeAccountStatus: 'active',
      department: '',
    },
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

  const pendingEmployee = await upsertSeedUser({
    id: EMPLOYEE_ID,
    phone: EMPLOYEE_PHONE,
    fullName: 'Дана Оспанова',
    password: EMPLOYEE_PASSWORD,
    status: 'pending',
  });

  await prisma.membership.upsert({
    where: { userId_orgId: { userId: pendingEmployee.id, orgId: org.id } },
    update: {
      role: 'viewer',
      status: 'active',
      source: 'admin_added',
      joinedAt: ago(10),
      department: 'Продажи',
      employeePermissions: ['sales'],
      addedById: owner.id,
      addedByName: owner.fullName,
      employeeAccountStatus: 'pending_first_login',
    },
    create: {
      userId: pendingEmployee.id,
      orgId: org.id,
      role: 'viewer',
      status: 'active',
      source: 'admin_added',
      joinedAt: ago(10),
      department: 'Продажи',
      employeePermissions: ['sales'],
      addedById: owner.id,
      addedByName: owner.fullName,
      employeeAccountStatus: 'pending_first_login',
    },
  });

  await prisma.customer.upsert({
    where: { id: CUSTOMER_ID },
    update: {
      orgId: org.id,
      fullName: 'Айдана Бекова',
      phone: '+77010000009',
      email: 'aidana@example.kz',
      companyName: 'Bekova Studio',
      source: 'instagram',
      notes: 'Seeded customer for E2E regressions',
      tags: ['seed', 'e2e'],
    },
    create: {
      id: CUSTOMER_ID,
      orgId: org.id,
      fullName: 'Айдана Бекова',
      phone: '+77010000009',
      email: 'aidana@example.kz',
      companyName: 'Bekova Studio',
      source: 'instagram',
      notes: 'Seeded customer for E2E regressions',
      tags: ['seed', 'e2e'],
    },
  });

  await prisma.chapanProfile.upsert({
    where: { orgId: org.id },
    update: {
      displayName: 'Чапан Цех',
      descriptor: 'Ателье национальной одежды',
      orderPrefix: 'ЧП',
    },
    create: {
      orgId: org.id,
      displayName: 'Чапан Цех',
      descriptor: 'Ателье национальной одежды',
      orderPrefix: 'ЧП',
    },
  });

  await prisma.chapanWorker.createMany({
    data: ['Айгуль М.', 'Нурлан К.', 'Гульнар А.', 'Бакыт С.'].map((name) => ({
      orgId: org.id,
      name,
    })),
    skipDuplicates: true,
  });

  await prisma.chapanCatalogProduct.createMany({
    data: ['Чапан мужской', 'Чапан женский', 'Камзол', 'Белдемше', 'Саукеле'].map((name) => ({
      orgId: org.id,
      name,
    })),
    skipDuplicates: true,
  });

  await prisma.chapanCatalogFabric.createMany({
    data: ['Бархат', 'Атлас', 'Шелк', 'Парча', 'Трикотаж'].map((name) => ({
      orgId: org.id,
      name,
    })),
    skipDuplicates: true,
  });

  await prisma.chapanCatalogSize.createMany({
    data: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '44', '46', '48', '50', '52', '54'].map((name) => ({
      orgId: org.id,
      name,
    })),
    skipDuplicates: true,
  });

  console.log('Seed complete.');
  console.log('');
  console.log('  Owner login:');
  console.log(`    Email:    ${OWNER_EMAIL}`);
  console.log('    Password: demo1234');
  console.log('  Employee first login:');
  console.log(`    Phone:    ${EMPLOYEE_PHONE}`);
  console.log(`    Password: ${EMPLOYEE_PHONE}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
