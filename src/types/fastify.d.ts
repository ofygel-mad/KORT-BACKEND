import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated user id (set by auth plugin) */
    userId: string;
    /** Authenticated user email */
    userEmail: string;
    /** Authenticated user full name */
    userFullName: string;
    /** Active organization id (set by org-scope plugin) */
    orgId: string;
    /** User's role within the active organization */
    orgRole: string;
  }
}
