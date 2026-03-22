import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from '../../config.js';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/hash.js';
import { signAccessToken, signRefreshToken } from '../../lib/jwt.js';
import { prisma } from '../../lib/prisma.js';
import { buildCapabilities } from '../auth/auth.service.js';

const DEMO_OWNER_EMAIL = 'admin@kort.local';
const DEMO_OWNER_PHONE = '+77010000001';
const DEMO_OWNER_PASSWORD = 'demo1234';
const DEMO_OWNER_NAME = 'Demo Owner';
const DEMO_ORG_ID = 'org-demo';
const DEMO_ORG_NAME = 'Demo Company';
const DEMO_ORG_SLUG = 'demo-company';
const SERVICE_CREDENTIAL_ID = 'service-console';
const DEFAULT_SERVICE_PASSWORD = 'kortdev1234';

const accessSchema = z.object({ password: z.string().min(1) });
const changePasswordSchema = z.object({
  current_password: z.string().min(1, 'Current password is required.'),
  new_password: z.string().min(8, 'New password must contain at least 8 characters.'),
});

async function ensureServiceCredential() {
  const existing = await prisma.serviceCredential.findUnique({
    where: { id: SERVICE_CREDENTIAL_ID },
  });

  if (existing) {
    return existing;
  }

  const seedPassword = config.CONSOLE_SERVICE_PASSWORD?.trim() || DEFAULT_SERVICE_PASSWORD;
  const passwordHash = await hashPassword(seedPassword);

  return prisma.serviceCredential.upsert({
    where: { id: SERVICE_CREDENTIAL_ID },
    update: {},
    create: {
      id: SERVICE_CREDENTIAL_ID,
      passwordHash,
    },
  });
}

async function verifyServiceAccessPassword(secret: string) {
  const credential = await ensureServiceCredential();
  return verifyPassword(secret, credential.passwordHash);
}

async function assertOwnerSession(userId: string) {
  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      role: 'owner',
      status: 'active',
    },
  });

  if (!membership) {
    throw new ForbiddenError('Only an active owner can rotate the service password.');
  }
}

async function ensureServiceOwnerMembership() {
  const existing = await prisma.membership.findFirst({
    where: { role: 'owner', status: 'active' },
    include: { user: true, org: true },
    orderBy: { joinedAt: 'asc' },
  });

  if (existing) {
    return existing;
  }

  const passwordHash = await hashPassword(DEMO_OWNER_PASSWORD);

  await prisma.$transaction(async (tx) => {
    const owner = await tx.user.upsert({
      where: { email: DEMO_OWNER_EMAIL },
      update: {
        fullName: DEMO_OWNER_NAME,
        phone: DEMO_OWNER_PHONE,
        status: 'active',
      },
      create: {
        id: 'u-owner',
        email: DEMO_OWNER_EMAIL,
        phone: DEMO_OWNER_PHONE,
        fullName: DEMO_OWNER_NAME,
        password: passwordHash,
        status: 'active',
      },
    });

    const org = await tx.organization.upsert({
      where: { slug: DEMO_ORG_SLUG },
      update: {
        name: DEMO_ORG_NAME,
        currency: 'KZT',
        mode: 'advanced',
        onboardingCompleted: true,
      },
      create: {
        id: DEMO_ORG_ID,
        name: DEMO_ORG_NAME,
        slug: DEMO_ORG_SLUG,
        currency: 'KZT',
        mode: 'advanced',
        onboardingCompleted: true,
      },
    });

    await tx.membership.upsert({
      where: { userId_orgId: { userId: owner.id, orgId: org.id } },
      update: {
        role: 'owner',
        status: 'active',
        source: 'service_bootstrap',
        joinedAt: new Date(),
        employeeAccountStatus: 'active',
      },
      create: {
        userId: owner.id,
        orgId: org.id,
        role: 'owner',
        status: 'active',
        source: 'service_bootstrap',
        joinedAt: new Date(),
        employeeAccountStatus: 'active',
      },
    });

    await tx.chapanProfile.upsert({
      where: { orgId: org.id },
      update: {},
      create: {
        orgId: org.id,
        displayName: 'Чапан Цех',
        descriptor: 'Demo workspace',
      },
    });
  });

  return prisma.membership.findFirstOrThrow({
    where: { role: 'owner', status: 'active' },
    include: { user: true, org: true },
    orderBy: { joinedAt: 'asc' },
  });
}

export async function serviceRoutes(app: FastifyInstance) {
  // POST /api/v1/service/access
  app.post('/access', async (request, reply) => {
    const body = accessSchema.parse(request.body);
    const accepted = await verifyServiceAccessPassword(body.password);
    if (!accepted) {
      throw new UnauthorizedError('Access denied.');
    }

    const membership = await ensureServiceOwnerMembership();

    const { user, org } = membership;
    const jti = nanoid();
    const access = signAccessToken({ sub: user.id, email: user.email ?? '' });
    const refresh = signRefreshToken({ sub: user.id, jti });

    await prisma.refreshToken.create({
      data: {
        id: jti,
        token: refresh,
        userId: user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const caps = buildCapabilities('owner', true, []);

    return reply.send({
      access,
      refresh,
      user: {
        id: user.id,
        full_name: user.fullName,
        email: user.email,
        phone: user.phone,
        avatar_url: user.avatarUrl,
        status: user.status,
        is_owner: true,
        employee_permissions: [],
        account_status: 'active',
      },
      org: {
        id: org.id,
        name: org.name,
        slug: org.slug,
        mode: org.mode,
        currency: org.currency,
        onboarding_completed: org.onboardingCompleted,
      },
      role: 'owner',
      capabilities: caps,
      membership: {
        companyId: org.id,
        companyName: org.name,
        companySlug: org.slug,
        status: 'active',
        role: 'owner',
        source: 'manual',
        requestId: null,
        inviteToken: null,
        joinedAt: membership.joinedAt?.toISOString() ?? new Date().toISOString(),
        updatedAt: membership.updatedAt.toISOString(),
      },
    });
  });

  app.post('/password', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);

    if (body.current_password === body.new_password) {
      throw new ValidationError('New password must be different from the current password.');
    }

    await assertOwnerSession(request.userId);

    const accepted = await verifyServiceAccessPassword(body.current_password);
    if (!accepted) {
      throw new UnauthorizedError('Current service password is incorrect.');
    }

    const passwordHash = await hashPassword(body.new_password);
    const credential = await prisma.serviceCredential.upsert({
      where: { id: SERVICE_CREDENTIAL_ID },
      update: { passwordHash },
      create: {
        id: SERVICE_CREDENTIAL_ID,
        passwordHash,
      },
    });

    return reply.send({
      ok: true,
      updated_at: credential.updatedAt.toISOString(),
    });
  });
}
