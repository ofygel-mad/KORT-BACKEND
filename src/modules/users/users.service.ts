import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';

/**
 * Returns the current user's profile.
 * Includes employee_permissions and account_status for frontend hooks.
 */
export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User', userId);

  // Fetch the most relevant active membership to expose employee fields
  const membership = await prisma.membership.findFirst({
    where: { userId, status: 'active' },
    orderBy: { joinedAt: 'desc' },
  });

  return {
    id: user.id,
    full_name: user.fullName,
    email: user.email,
    phone: user.phone,
    avatar_url: user.avatarUrl,
    status: user.status,
    is_owner: membership?.role === 'owner',
    employee_permissions: membership?.employeePermissions ?? [],
    account_status: membership?.employeeAccountStatus ?? 'active',
  };
}

/**
 * Lists all active members in an org.
 * Used by the Team section in Settings (legacy, not the new EmployeePanel).
 */
export async function getTeam(orgId: string) {
  const members = await prisma.membership.findMany({
    where: { orgId, status: 'active' },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });

  return members.map((m) => ({
    id: m.user.id,
    full_name: m.user.fullName,
    email: m.user.email,
    phone: m.user.phone,
    status: m.user.status,
    role: m.role,
    department: m.department,
    employee_account_status: m.employeeAccountStatus,
    permissions: m.employeePermissions,
  }));
}

export async function updateUserRole(userId: string, orgId: string, role: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) throw new NotFoundError('Membership');
  if (membership.role === 'owner') {
    throw new ForbiddenError('Роль руководителя не может быть изменена.');
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: { role },
  });
}

export async function activateUser(userId: string, orgId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) throw new ForbiddenError('Пользователь не является членом текущей организации.');

  await prisma.membership.update({
    where: { id: membership.id },
    data: {
      status: 'active',
      joinedAt: membership.joinedAt ?? new Date(),
      employeeAccountStatus: 'active',
    },
  });
}

export async function deactivateUser(userId: string, orgId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) throw new ForbiddenError('Пользователь не является членом текущей организации.');
  if (membership.role === 'owner') {
    throw new ForbiddenError('Нельзя деактивировать руководителя.');
  }

  await prisma.membership.update({
    where: { id: membership.id },
    data: { status: 'inactive' },
  });
}
