import { nanoid } from 'nanoid';
import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

export async function submitMembershipRequest(userId: string, fullName: string, email: string, companyId: string) {
  const org = await prisma.organization.findUnique({ where: { id: companyId } });
  if (!org) throw new NotFoundError('Organization', companyId);

  const existing = await prisma.membershipRequest.findFirst({
    where: { userId, orgId: companyId, status: 'pending' },
  });

  if (existing) {
    return {
      request: existing,
      membership: await ensurePendingMembership(userId, companyId),
    };
  }

  const membershipRequest = await prisma.membershipRequest.create({
    data: {
      userId,
      orgId: companyId,
      fullName,
      email,
      requestedRole: 'viewer',
    },
  });

  const membership = await ensurePendingMembership(userId, companyId);

  return {
    request: {
      id: membershipRequest.id,
      user_id: membershipRequest.userId,
      full_name: membershipRequest.fullName,
      email: membershipRequest.email,
      company_id: membershipRequest.orgId,
      company_name: org.name,
      status: membershipRequest.status,
      requested_role: membershipRequest.requestedRole,
      created_at: membershipRequest.createdAt.toISOString(),
    },
    membership: {
      companyId: membership.orgId,
      companyName: org.name,
      companySlug: org.slug,
      status: membership.status,
      role: 'viewer',
      source: 'request',
      requestId: membershipRequest.id,
      inviteToken: null,
      joinedAt: null,
      updatedAt: membership.updatedAt.toISOString(),
    },
  };
}

async function ensurePendingMembership(userId: string, orgId: string) {
  return prisma.membership.upsert({
    where: { userId_orgId: { userId, orgId } },
    create: { userId, orgId, role: 'viewer', status: 'pending', source: 'request' },
    update: { status: 'pending', source: 'request' },
  });
}

export async function getMyRequests(userId: string) {
  const requests = await prisma.membershipRequest.findMany({
    where: { userId },
    include: { org: true },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map((r) => ({
    id: r.id,
    user_id: r.userId,
    full_name: r.fullName,
    email: r.email,
    company_id: r.orgId,
    company_name: r.org.name,
    status: r.status,
    requested_role: r.requestedRole,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function getAdminRequests(orgId: string) {
  const requests = await prisma.membershipRequest.findMany({
    where: { orgId },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map((r) => ({
    id: r.id,
    user_id: r.userId,
    full_name: r.fullName,
    email: r.email,
    company_id: r.orgId,
    status: r.status,
    requested_role: r.requestedRole,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function approveRequest(requestId: string, orgId: string) {
  const req = await prisma.membershipRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('MembershipRequest', requestId);
  if (req.orgId !== orgId) throw new ForbiddenError('Запрос не принадлежит текущей организации.');

  await prisma.$transaction(async (tx) => {
    await tx.membershipRequest.update({
      where: { id: requestId },
      data: { status: 'approved' },
    });

    await tx.membership.upsert({
      where: { userId_orgId: { userId: req.userId, orgId: req.orgId } },
      create: {
        userId: req.userId,
        orgId: req.orgId,
        role: req.requestedRole,
        status: 'active',
        source: 'request',
        joinedAt: new Date(),
      },
      update: {
        role: req.requestedRole,
        status: 'active',
        joinedAt: new Date(),
      },
    });

    await tx.user.update({
      where: { id: req.userId },
      data: { status: 'active' },
    });
  });
}

export async function rejectRequest(requestId: string, orgId: string) {
  const req = await prisma.membershipRequest.findUnique({ where: { id: requestId } });
  if (!req) throw new NotFoundError('MembershipRequest', requestId);
  if (req.orgId !== orgId) throw new ForbiddenError('Запрос не принадлежит текущей организации.');

  await prisma.$transaction(async (tx) => {
    await tx.membershipRequest.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    await tx.membership.upsert({
      where: { userId_orgId: { userId: req.userId, orgId: req.orgId } },
      create: {
        userId: req.userId,
        orgId: req.orgId,
        role: 'viewer',
        status: 'rejected',
        source: 'request',
      },
      update: {
        status: 'rejected',
      },
    });
  });
}

export async function createInvite(orgId: string, orgName: string, orgSlug: string, createdBy: string, role: string, kind: string) {
  const token = `invite-${nanoid()}`;

  const invite = await prisma.invite.create({
    data: {
      token,
      orgId,
      role,
      kind,
      createdBy,
      autoApprove: true,
    },
  });

  return {
    token: invite.token,
    companyId: orgId,
    companyName: orgName,
    companySlug: orgSlug,
    role: invite.role,
    autoApprove: invite.autoApprove,
    kind: invite.kind,
    created_at: invite.createdAt.toISOString(),
    created_by: invite.createdBy,
    share_url: `/auth/accept-invite?token=${invite.token}`,
    expiresAt: null,
  };
}

export async function listInvites(orgId: string) {
  const invites = await prisma.invite.findMany({
    where: { orgId },
    include: { org: true },
    orderBy: { createdAt: 'desc' },
  });

  return invites.map((inv) => ({
    token: inv.token,
    companyId: inv.orgId,
    companyName: inv.org.name,
    companySlug: inv.org.slug,
    role: inv.role,
    autoApprove: inv.autoApprove,
    kind: inv.kind,
    created_at: inv.createdAt.toISOString(),
    created_by: inv.createdBy,
    share_url: `/auth/accept-invite?token=${inv.token}`,
    expiresAt: inv.expiresAt?.toISOString() ?? null,
  }));
}

export async function getInvite(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { token },
    include: { org: true },
  });
  if (!invite) return null;

  let status: 'valid' | 'used' | 'expired';
  if (invite.usedAt) {
    status = 'used';
  } else if (invite.expiresAt && invite.expiresAt < new Date()) {
    status = 'expired';
  } else {
    status = 'valid';
  }

  return {
    token: invite.token,
    companyId: invite.orgId,
    companyName: invite.org.name,
    companySlug: invite.org.slug,
    role: invite.role,
    autoApprove: invite.autoApprove,
    kind: invite.kind,
    expiresAt: invite.expiresAt?.toISOString() ?? null,
    status,
  };
}
