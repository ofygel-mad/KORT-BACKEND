import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { hashPassword } from '../../lib/hash.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../lib/errors.js';

// ─── Validation schemas ───────────────────────────────────────────────────────

const VALID_PERMISSIONS = [
  'full_access',
  'financial_report',
  'sales',
  'production',
  'warehouse_manager',
  'observer',
  // ─── Chapan module ───
  'chapan_full_access',
  'chapan_access_orders',
  'chapan_access_production',
  'chapan_access_ready',
  'chapan_access_archive',
  'chapan_access_warehouse_nav',
  'chapan_manage_production',
  'chapan_confirm_invoice',
  'chapan_manage_settings',
] as const;

export const createEmployeeSchema = z.object({
  phone: z
    .string()
    .min(7)
    .regex(/^\+7\d{10}$/, 'Телефон должен быть в формате +7XXXXXXXXXX'),
  full_name: z.string().min(2).max(120),
  department: z.string().min(1).max(80),
  permissions: z
    .array(z.enum(VALID_PERMISSIONS))
    .min(1, 'Назначьте хотя бы одно право доступа'),
});

export const updateEmployeeSchema = z.object({
  department: z.string().min(1).max(80).optional(),
  permissions: z.array(z.enum(VALID_PERMISSIONS)).optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

// ─── Serializer ───────────────────────────────────────────────────────────────

function serializeEmployee(
  membership: {
    userId: string;
    department: string;
    employeePermissions: string[];
    employeeAccountStatus: string;
    addedById: string | null;
    addedByName: string | null;
    createdAt: Date;
    user: {
      fullName: string;
      phone: string | null;
    };
  },
) {
  return {
    id: membership.userId,
    full_name: membership.user.fullName,
    phone: membership.user.phone ?? '',
    department: membership.department,
    permissions: membership.employeePermissions,
    // 'pending_first_login' counts as active for display purposes
    status: membership.employeeAccountStatus === 'dismissed' ? 'dismissed' : 'active',
    isPendingFirstLogin: membership.employeeAccountStatus === 'pending_first_login',
    addedByName: membership.addedByName ?? '',
    joinedAt: membership.createdAt.toISOString(),
  };
}

const EMPLOYEE_MEMBERSHIP_SELECT = {
  userId: true,
  department: true,
  employeePermissions: true,
  employeeAccountStatus: true,
  addedById: true,
  addedByName: true,
  createdAt: true,
  user: {
    select: {
      fullName: true,
      phone: true,
    },
  },
} as const;

// ─── List employees ───────────────────────────────────────────────────────────

export async function listEmployees(orgId: string) {
  const memberships = await prisma.membership.findMany({
    where: {
      orgId,
      status: 'active',
      // Only show employees added by admin (not the owner themselves)
      source: { in: ['admin_added', 'invite', 'request', 'manual'] },
      // Don't show the org owner in the employee list — they're the boss
      role: { not: 'owner' },
    },
    select: EMPLOYEE_MEMBERSHIP_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map(serializeEmployee);
}

// ─── Create employee ──────────────────────────────────────────────────────────

export async function createEmployee(
  orgId: string,
  addedByUserId: string,
  addedByName: string,
  data: CreateEmployeeInput,
) {
  // Verify the phone isn't already registered
  const existingUser = await prisma.user.findUnique({
    where: { phone: data.phone },
  });

  if (existingUser) {
    // Check if they're already a member of this org
    const existingMembership = await prisma.membership.findUnique({
      where: { userId_orgId: { userId: existingUser.id, orgId } },
    });
    if (existingMembership) {
      throw new ConflictError(
        'Сотрудник с таким номером телефона уже добавлен в эту компанию.',
      );
    }
    // User exists globally but isn't in this org — can still add them
    // (they might work for multiple companies)
    const membership = await prisma.membership.create({
      data: {
        userId: existingUser.id,
        orgId,
        role: 'viewer',
        status: 'active',
        source: 'admin_added',
        joinedAt: new Date(),
        department: data.department,
        employeePermissions: data.permissions,
        addedById: addedByUserId,
        addedByName,
        employeeAccountStatus: 'pending_first_login',
      },
      select: {
        ...EMPLOYEE_MEMBERSHIP_SELECT,
        user: { select: { fullName: true, phone: true } },
      },
    });
    return serializeEmployee(membership);
  }

  // Create a brand-new user.
  // Initial password = hashed phone number (enables the phone+phone first-login).
  const hashedPhone = await hashPassword(data.phone);

  try {
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          fullName: data.full_name.trim(),
          phone: data.phone,
          password: hashedPhone,
          status: 'pending',
          // email intentionally null — employees log in by phone
        },
      });

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          orgId,
          role: 'viewer',
          status: 'active',
          source: 'admin_added',
          joinedAt: new Date(),
          department: data.department,
          employeePermissions: data.permissions,
          addedById: addedByUserId,
          addedByName,
          employeeAccountStatus: 'pending_first_login',
        },
        select: {
          ...EMPLOYEE_MEMBERSHIP_SELECT,
          user: { select: { fullName: true, phone: true } },
        },
      });

      return membership;
    });

    return serializeEmployee(result);
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    ) {
      throw new ConflictError(
        'Сотрудник с таким номером телефона уже существует.',
      );
    }
    throw error;
  }
}

// ─── Update employee ──────────────────────────────────────────────────────────

export async function updateEmployee(
  orgId: string,
  userId: string,
  data: UpdateEmployeeInput,
) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });
  if (!membership) throw new NotFoundError('Employee');

  // Protect the owner: their permissions cannot be changed through this endpoint
  if (membership.role === 'owner') {
    throw new ForbiddenError(
      'Права руководителя не редактируются через интерфейс управления сотрудниками.',
    );
  }

  const updated = await prisma.membership.update({
    where: { userId_orgId: { userId, orgId } },
    data: {
      ...(data.department !== undefined && { department: data.department }),
      ...(data.permissions !== undefined && {
        employeePermissions: data.permissions,
      }),
    },
    select: {
      ...EMPLOYEE_MEMBERSHIP_SELECT,
      user: { select: { fullName: true, phone: true } },
    },
  });

  return serializeEmployee(updated);
}

// ─── Reset employee password ──────────────────────────────────────────────────

/**
 * Admin resets an employee's password.
 * Sets password back to hashed phone number and status back to pending_first_login.
 * Employee must do phone+phone login again and set a new password.
 */
export async function resetEmployeePassword(orgId: string, userId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    include: { user: true },
  });

  if (!membership) throw new NotFoundError('Employee');
  if (membership.role === 'owner') {
    throw new ForbiddenError(
      'Нельзя сбросить пароль руководителя через этот интерфейс.',
    );
  }
  if (membership.employeeAccountStatus === 'dismissed') {
    throw new ValidationError(
      'Нельзя сбросить пароль уволенного сотрудника.',
    );
  }

  const phone = membership.user.phone;
  if (!phone) {
    throw new ValidationError(
      'У этого сотрудника нет привязанного телефона. Смена пароля невозможна.',
    );
  }

  const hashedPhone = await hashPassword(phone);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { password: hashedPhone, status: 'pending' },
    });

    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: { employeeAccountStatus: 'pending_first_login' },
    });

    // Invalidate all refresh tokens for this user
    await tx.refreshToken.deleteMany({ where: { userId } });
  });

  return { ok: true, message: 'Пароль сброшен. Сотрудник должен войти через номер телефона.' };
}

// ─── Remove employee (permanent — deletes membership) ────────────────────────

export async function removeEmployee(orgId: string, userId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });

  if (!membership) throw new NotFoundError('Employee');
  if (membership.role === 'owner') {
    throw new ForbiddenError('Нельзя удалить руководителя.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.membership.delete({ where: { userId_orgId: { userId, orgId } } });
    await tx.refreshToken.deleteMany({ where: { userId } });
  });

  return { ok: true };
}

// ─── Dismiss employee ─────────────────────────────────────────────────────────

export async function dismissEmployee(orgId: string, userId: string) {
  const membership = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
  });

  if (!membership) throw new NotFoundError('Employee');
  if (membership.role === 'owner') {
    throw new ForbiddenError('Нельзя уволить руководителя.');
  }
  if (membership.employeeAccountStatus === 'dismissed') {
    throw new ValidationError('Сотрудник уже уволен.');
  }

  await prisma.$transaction(async (tx) => {
    // Mark as dismissed — login is blocked in auth.service.ts login()
    await tx.membership.update({
      where: { userId_orgId: { userId, orgId } },
      data: { employeeAccountStatus: 'dismissed' },
    });

    // Revoke all active refresh tokens immediately
    await tx.refreshToken.deleteMany({ where: { userId } });
  });

  return { ok: true, message: 'Сотрудник уволен. Доступ к аккаунту заблокирован.' };
}
