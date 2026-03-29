import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';

const FALLBACK_OWNER_ROLES = ['admin', 'manager', 'viewer'] as const;

export const transferOwnershipSchema = z.object({
  target_user_id: z.string().min(1),
  previous_owner_role: z.enum(FALLBACK_OWNER_ROLES).default('admin'),
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export async function transferOwnership(
  currentOwnerUserId: string,
  orgId: string,
  input: TransferOwnershipInput,
) {
  if (input.target_user_id === currentOwnerUserId) {
    throw new ValidationError('Нельзя передать владение самому себе.');
  }

  const [currentOwnerMembership, targetMembership, activeOwners, organization] =
    await Promise.all([
      prisma.membership.findUnique({
        where: { userId_orgId: { userId: currentOwnerUserId, orgId } },
        include: { user: true },
      }),
      prisma.membership.findUnique({
        where: { userId_orgId: { userId: input.target_user_id, orgId } },
        include: { user: true },
      }),
      prisma.membership.findMany({
        where: {
          orgId,
          role: 'owner',
          status: 'active',
          NOT: { employeeAccountStatus: 'dismissed' },
        },
        select: { userId: true },
      }),
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, name: true, slug: true },
      }),
    ]);

  if (!organization) {
    throw new NotFoundError('Organization', orgId);
  }

  if (!currentOwnerMembership || currentOwnerMembership.role !== 'owner') {
    throw new ForbiddenError('Передавать владение может только текущий владелец организации.');
  }

  if (activeOwners.length !== 1 || activeOwners[0]?.userId !== currentOwnerUserId) {
    throw new ConflictError(
      'Передача владения невозможна: в организации должен быть ровно один активный владелец.',
    );
  }

  if (!targetMembership) {
    throw new NotFoundError('Target member', input.target_user_id);
  }

  if (targetMembership.status !== 'active') {
    throw new ValidationError('Новый владелец должен быть активным участником организации.');
  }

  if (targetMembership.employeeAccountStatus === 'dismissed') {
    throw new ValidationError('Нельзя передать владение уволенному сотруднику.');
  }

  if (targetMembership.role === 'owner') {
    throw new ConflictError('Этот участник уже является владельцем организации.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.update({
      where: { id: targetMembership.id },
      data: {
        role: 'owner',
        status: 'active',
        employeeAccountStatus: 'active',
      },
    });

    await tx.membership.update({
      where: { id: currentOwnerMembership.id },
      data: {
        role: input.previous_owner_role,
        status: 'active',
        employeeAccountStatus: 'active',
      },
    });

    await tx.refreshToken.deleteMany({
      where: {
        userId: {
          in: [currentOwnerUserId, input.target_user_id],
        },
      },
    });
  });

  return {
    ok: true,
    org: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
    },
    previous_owner: {
      id: currentOwnerMembership.userId,
      full_name: currentOwnerMembership.user.fullName,
      email: currentOwnerMembership.user.email,
      next_role: input.previous_owner_role,
    },
    new_owner: {
      id: targetMembership.userId,
      full_name: targetMembership.user.fullName,
      email: targetMembership.user.email,
    },
    revoked_sessions: [currentOwnerUserId, input.target_user_id],
  };
}
