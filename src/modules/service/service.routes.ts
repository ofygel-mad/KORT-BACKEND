import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { config } from '../../config.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/hash.js';
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

function safeCompare(provided: string, expected: string): boolean {
  const pa = Buffer.allocUnsafe(128);
  const pb = Buffer.allocUnsafe(128);
  pa.fill(0);
  pb.fill(0);
  Buffer.from(provided).copy(pa);
  Buffer.from(expected).copy(pb);
  return timingSafeEqual(pa, pb) && provided === expected;
}

const accessSchema = z.object({ password: z.string().min(1) });

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
    const expected = config.CONSOLE_SERVICE_PASSWORD;
    if (!expected || !safeCompare(body.password, expected)) {
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
}
