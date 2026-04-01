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


// ── Update own profile (name, phone) ──────────────────────────────────────────
export async function updateMe(
  userId: string,
  data: { full_name?: string; phone?: string | null },
) {
  const { ConflictError } = await import('../../lib/errors.js');
  const { prisma } = await import('../../lib/prisma.js');

  const updates: Record<string, unknown> = {};

  if (data.full_name !== undefined) {
    const trimmed = data.full_name.trim();
    if (trimmed.length > 0) updates.fullName = trimmed;
  }

  if (data.phone !== undefined) {
    if (data.phone === null || data.phone === '') {
      updates.phone = null;
    } else {
      const trimmed = data.phone.trim();
      // Check uniqueness only if changing to a non-null value
      const existing = await prisma.user.findUnique({ where: { phone: trimmed } });
      if (existing && existing.id !== userId) {
        throw new ConflictError('Этот номер телефона уже привязан к другому аккаунту.');
      }
      updates.phone = trimmed;
    }
  }

  if (Object.keys(updates).length === 0) return { ok: true };

  const updated = await prisma.user.update({ where: { id: userId }, data: updates });

  return {
    ok: true,
    user: {
      id: updated.id,
      full_name: updated.fullName,
      email: updated.email,
      phone: updated.phone,
      avatar_url: updated.avatarUrl,
    },
  };
}

// ── Change email (owner self-service) ─────────────────────────────────────────
export async function changeEmail(
  userId: string,
  newEmail: string,
  currentPassword: string,
) {
  const { verifyPassword } = await import('../../lib/hash.js');
  const { ConflictError, ValidationError, ForbiddenError } = await import('../../lib/errors.js');
  const { prisma } = await import('../../lib/prisma.js');

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ForbiddenError('Пользователь не найден.');

  // Verify current password before allowing email change
  const valid = await verifyPassword(currentPassword, user.password);
  if (!valid) throw new ForbiddenError('Неверный текущий пароль.');

  const normalizedEmail = newEmail.trim().toLowerCase();
  if (!normalizedEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) {
    throw new ValidationError('Укажите корректный email-адрес.');
  }

  if (normalizedEmail === user.email?.toLowerCase()) {
    throw new ValidationError('Новый email совпадает с текущим.');
  }

  // Check uniqueness
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) throw new ConflictError('Этот email уже используется другим аккаунтом.');

  // Update email and revoke all sessions (force re-login)
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { email: normalizedEmail },
    });
    // Revoke all refresh tokens → user must log in with new email
    await tx.refreshToken.deleteMany({ where: { userId } });
  });

  return { ok: true };
}
