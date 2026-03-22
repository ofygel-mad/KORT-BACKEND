import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { verifyAccessToken } from '../lib/jwt.js';
import { UnauthorizedError } from '../lib/errors.js';

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('userId', '');
  fastify.decorateRequest('userEmail', '');
  fastify.decorateRequest('userFullName', '');

  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Требуется корректный Bearer token.');
    }

    const token = header.slice(7);

    try {
      const payload = verifyAccessToken(token);
      request.userId = payload.sub;
      request.userEmail = payload.email;
    } catch {
      throw new UnauthorizedError('Access token недействителен или истёк.');
    }
  });

  fastify.decorate('optionalAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return;

    try {
      const payload = verifyAccessToken(header.slice(7));
      request.userId = payload.sub;
      request.userEmail = payload.email;
    } catch {
      // Silently ignore invalid tokens for optional auth
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(authPlugin, { name: 'auth' });
