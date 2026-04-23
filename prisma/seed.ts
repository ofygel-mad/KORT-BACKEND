import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const OWNER_EMAIL = 'admin@kort.local';
const OWNER_PHONE = '+77010000001';
const OWNER_ID = 'u-owner';
const ORG_ID = 'org-workspace';
const ORG_SLUG = 'workspace';
const EMPLOYEE_ID = 'u-employee-pending';
const EMPLOYEE_PHONE = '+77010000003';

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
    name: 'Workspace',
    slug: ORG_SLUG,
    mode: 'industrial',
    onboardingCompleted: true,
    currency: 'KZT',
    industry: 'Operations',
    legalForm: 'Workspace',
    legalName: 'Workspace',
    city: 'Remote',
    director: 'Owner',
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
    fullName: 'Owner',
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

  const employee = await upsertSeedUser({
    id: EMPLOYEE_ID,
    phone: EMPLOYEE_PHONE,
    fullName: 'Demo Employee',
    password: EMPLOYEE_PASSWORD,
    status: 'active',
  });

  await prisma.membership.upsert({
    where: { userId_orgId: { userId: employee.id, orgId: org.id } },
    update: {
      role: 'manager',
      status: 'active',
      source: 'admin_added',
      joinedAt: ago(15),
      department: 'Склад',
      employeePermissions: ['warehouse_manager'],
      employeeAccountStatus: 'pending_first_login',
      addedById: owner.id,
      addedByName: owner.fullName,
    },
    create: {
      userId: employee.id,
      orgId: org.id,
      role: 'manager',
      status: 'active',
      source: 'admin_added',
      joinedAt: ago(15),
      department: 'Склад',
      employeePermissions: ['warehouse_manager'],
      employeeAccountStatus: 'pending_first_login',
      addedById: owner.id,
      addedByName: owner.fullName,
    },
  });

  await prisma.chapanProfile.upsert({
    where: { orgId: org.id },
    update: {
      displayName: 'Workspace',
      descriptor: 'Operations',
      orderPrefix: 'ORD',
    },
    create: {
      orgId: org.id,
      displayName: 'Workspace',
      descriptor: 'Operations',
      orderPrefix: 'ORD',
    },
  });

  await prisma.chapanCatalogProduct.createMany({
    data: ['Product A', 'Product B', 'Product C', 'Product D', 'Product E'].map((name) => ({
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

  const existingCustomer = await prisma.customer.findFirst({
    where: {
      orgId: org.id,
      email: 'aidana@example.kz',
    },
  });

  if (existingCustomer) {
    await prisma.customer.update({
      where: { id: existingCustomer.id },
      data: {
        fullName: 'Aidana Demo',
        phone: '+77015554433',
        companyName: 'Workspace',
        source: 'seed',
      },
    });
  } else {
    await prisma.customer.create({
      data: {
        orgId: org.id,
        fullName: 'Aidana Demo',
        phone: '+77015554433',
        email: 'aidana@example.kz',
        companyName: 'Workspace',
        source: 'seed',
      },
    });
  }

  console.log('Seed complete.');
  console.log('');
  console.log('  Owner login:');
  console.log(`    Email:    ${OWNER_EMAIL}`);
  console.log('    Password: demo1234');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
