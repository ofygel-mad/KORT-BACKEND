import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

const ROLE_HIERARCHY: Record<string, number> = {
  owner: 4,
  admin: 3,
  manager: 2,
  viewer: 1,
};

function isBlockedEmployeeStatus(status: string | null | undefined) {
  return status === 'dismissed' || status === 'pending_first_login';
}

async function orgScopePlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('orgId', '');
  fastify.decorateRequest('orgRole', '');

  /**
   * Resolves the user's active organization from their membership.
   * Blocks dismissed employees from accessing protected routes.
   * Must run AFTER authenticate.
   */
  fastify.decorate('resolveOrg', async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.userId) {
      throw new ForbiddenError('Authentication required before org resolution');
    }

    const xOrgId =
      typeof request.headers['x-org-id'] === 'string'
        ? request.headers['x-org-id']
        : null;

    if (xOrgId) {
      const requested = await prisma.membership.findUnique({
        where: { userId_orgId: { userId: request.userId, orgId: xOrgId } },
        include: { user: true },
      });

      if (requested && requested.status === 'active' && !isBlockedEmployeeStatus(requested.employeeAccountStatus)) {
        request.orgId = requested.orgId;
        request.orgRole = requested.role;
        request.userFullName = requested.user.fullName;
        return;
      }

      if (requested && requested.status === 'active' && requested.employeeAccountStatus === 'pending_first_login') {
        throw new UnauthorizedError('Password reset requires a new login.');
      }
    }

    const membership = await prisma.membership.findFirst({
      where: {
        userId: request.userId,
        status: 'active',
        NOT: { employeeAccountStatus: { in: ['dismissed', 'pending_first_login'] } },
      },
      include: { user: true },
      orderBy: { joinedAt: 'desc' },
    });

    if (!membership) {
      const pendingMembership = await prisma.membership.findFirst({
        where: {
          userId: request.userId,
          status: 'active',
          employeeAccountStatus: 'pending_first_login',
        },
        select: { userId: true },
      });

      if (pendingMembership) {
        throw new UnauthorizedError('Password reset requires a new login.');
      }

      throw new ForbiddenError('No active organization membership');
    }

    request.orgId = membership.orgId;
    request.orgRole = membership.role;
    request.userFullName = membership.user.fullName;
  });

  /**
   * Requires a minimum role level within the org.
   */
  fastify.decorate('requireRole', (...roles: string[]) => {
    return async (request: FastifyRequest, _reply: FastifyReply) => {
      const minLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] ?? 0));
      const userLevel = ROLE_HIERARCHY[request.orgRole] ?? 0;

      if (userLevel < minLevel) {
        throw new ForbiddenError(`Requires one of: ${roles.join(', ')}`);
      }
    };
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    resolveOrg: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      ...roles: string[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(orgScopePlugin, { name: 'org-scope', dependencies: ['auth'] });
