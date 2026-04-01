import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as chatService from './chat.service.js';

export async function chatRoutes(app: FastifyInstance) {
  // GET /api/v1/chat/conversations/
  app.get('/conversations', {
    preHandler: [app.authenticate, app.resolveOrg],
  }, async (request) => {
    return chatService.getConversations(request.userId);
  });

  // POST /api/v1/chat/conversations/
  app.post('/conversations', {
    preHandler: [app.authenticate, app.resolveOrg],
  }, async (request, reply) => {
    const { participant_id } = z.object({
      participant_id: z.string().min(1),
    }).parse(request.body);

    const result = await chatService.findOrCreate(request.userId, participant_id, request.orgId);
    return reply.status(201).send(result);
  });

  // GET /api/v1/chat/conversations/:id/messages/
  app.get('/conversations/:id/messages', {
    preHandler: [app.authenticate],
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { cursor, limit } = z.object({
      cursor: z.string().optional().default(''),
      limit: z.coerce.number().int().min(1).max(100).optional().default(40),
    }).parse(request.query);

    return chatService.getMessages(id, request.userId, cursor || null, limit);
  });

  // POST /api/v1/chat/conversations/:id/messages/
  app.post('/conversations/:id/messages', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { body } = z.object({
      body: z.string().min(1).max(4000),
    }).parse(request.body);

    const message = await chatService.sendMessage(id, request.userId, body);
    return reply.status(201).send(message);
  });

  // POST /api/v1/chat/conversations/:id/read/
  app.post('/conversations/:id/read', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(await chatService.markRead(id, request.userId));
  });
}
