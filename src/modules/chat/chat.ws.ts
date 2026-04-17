/**
 * chat.ws.ts — WebSocket layer for real-time chat
 *
 * Events pushed to client (server → client):
 *   { type: 'message.new',     conversation_id, message }
 *   { type: 'message.read',    conversation_id, reader_id, read_at }
 *   { type: 'message.edited',  conversation_id, message }
 *   { type: 'message.deleted', conversation_id, message_id, deleted_at }
 *   { type: 'typing',          conversation_id, user_id, user_name, is_typing }
 *   { type: 'presence.update', user_id, status: 'online'|'offline' }
 *   { type: 'ping' }   ← server heartbeat
 *
 * Events accepted from client (client → server):
 *   { type: 'typing.start',  conversation_id }
 *   { type: 'typing.stop',   conversation_id }
 *   { type: 'presence.ping' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from '../../lib/jwt.js';
import { prisma } from '../../lib/prisma.js';

// ── Connection registry ────────────────────────────────────────────────────

interface UserConnection {
  ws: WebSocket;
  userId: string;
  userFullName: string;
  orgIds: Set<string>;
}

const connections = new Map<string, Set<UserConnection>>();

// ── Typing state (in-memory only) ─────────────────────────────────────────

const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function typingKey(convId: string, userId: string) {
  return `${convId}:${userId}`;
}

async function getConversationParticipantIds(convId: string): Promise<string[]> {
  const participants = await prisma.conversationParticipant.findMany({
    where: { conversationId: convId },
    select: { userId: true },
  });
  return participants.map((p) => p.userId);
}

// ── Public API ─────────────────────────────────────────────────────────────

export function broadcastToUser(userId: string, event: object) {
  const userConns = connections.get(userId);
  if (!userConns?.size) return;
  const payload = JSON.stringify(event);
  for (const conn of userConns) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(payload);
    }
  }
}

function broadcastToOrgPeers(orgId: string, excludeUserId: string, event: object) {
  const payload = JSON.stringify(event);
  for (const [userId, userConns] of connections) {
    if (userId === excludeUserId) continue;
    for (const conn of userConns) {
      if (conn.orgIds.has(orgId) && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(payload);
      }
    }
  }
}

function broadcastPresence(userId: string, status: 'online' | 'offline') {
  const userConns = connections.get(userId);
  if (!userConns?.size) return;

  for (const conn of userConns) {
    for (const orgId of conn.orgIds) {
      broadcastToOrgPeers(orgId, userId, { type: 'presence.update', user_id: userId, status });
    }
    break; // use first connection's orgIds only
  }
}

export function attachChatWebSocket(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    if (url.pathname !== '/api/v1/ws/chat') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let userId: string;
    try {
      const payload = verifyAccessToken(token);
      userId = payload.sub;
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, async (ws) => {
      // Load user display name and org memberships
      const dbUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      });
      const userFullName = dbUser?.fullName ?? '';

      // Load org IDs for this user
      const memberships = await prisma.membership.findMany({
        where: { userId, status: 'active' },
        select: { orgId: true },
      });
      const orgIds = new Set(memberships.map((m) => m.orgId));

      const conn: UserConnection = { ws, userId, userFullName, orgIds };

      if (!connections.has(userId)) connections.set(userId, new Set());
      connections.get(userId)!.add(conn);

      // Send connected ack
      ws.send(JSON.stringify({ type: 'connected', user_id: userId }));

      // Broadcast online presence to org peers
      for (const orgId of orgIds) {
        broadcastToOrgPeers(orgId, userId, {
          type: 'presence.update',
          user_id: userId,
          status: 'online',
        });
      }

      // Heartbeat ping every 25s
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        } else {
          clearInterval(pingInterval);
        }
      }, 25_000);

      function cleanup() {
        clearInterval(pingInterval);
        const set = connections.get(userId);
        if (set) {
          set.delete(conn);
          if (set.size === 0) {
            connections.delete(userId);
            // Broadcast offline after 60s grace period
            setTimeout(() => {
              if (!connections.has(userId)) {
                broadcastPresence(userId, 'offline');
              }
            }, 60_000);
          }
        }

        // Clear any active typing timers for this user
        for (const [key] of typingTimers) {
          if (key.endsWith(`:${userId}`)) {
            clearTimeout(typingTimers.get(key)!);
            typingTimers.delete(key);
          }
        }
      }

      ws.on('close', cleanup);
      ws.on('error', cleanup);

      ws.on('message', async (raw: Buffer) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }

        switch (event.type) {
          case 'typing.start': {
            const convId = event.conversation_id as string;
            if (!convId) break;

            const key = typingKey(convId, userId);

            // Clear existing auto-stop timer
            if (typingTimers.has(key)) {
              clearTimeout(typingTimers.get(key)!);
            }

            // Broadcast typing=true to all conversation participants except self
            try {
              const participantIds = await getConversationParticipantIds(convId);
              for (const pid of participantIds) {
                if (pid !== userId) {
                  broadcastToUser(pid, {
                    type: 'typing',
                    conversation_id: convId,
                    user_id: userId,
                    user_name: userFullName,
                    is_typing: true,
                  });
                }
              }
            } catch {}

            // Auto-stop after 4s of no activity
            typingTimers.set(key, setTimeout(async () => {
              typingTimers.delete(key);
              try {
                const participantIds = await getConversationParticipantIds(convId);
                for (const pid of participantIds) {
                  if (pid !== userId) {
                    broadcastToUser(pid, {
                      type: 'typing',
                      conversation_id: convId,
                      user_id: userId,
                      user_name: userFullName,
                      is_typing: false,
                    });
                  }
                }
              } catch {}
            }, 4000));

            break;
          }

          case 'typing.stop': {
            const convId = event.conversation_id as string;
            if (!convId) break;

            const key = typingKey(convId, userId);
            if (typingTimers.has(key)) {
              clearTimeout(typingTimers.get(key)!);
              typingTimers.delete(key);
            }

            try {
              const participantIds = await getConversationParticipantIds(convId);
              for (const pid of participantIds) {
                if (pid !== userId) {
                  broadcastToUser(pid, {
                    type: 'typing',
                    conversation_id: convId,
                    user_id: userId,
                    user_name: userFullName,
                    is_typing: false,
                  });
                }
              }
            } catch {}

            break;
          }

          case 'presence.ping':
            // Client is active — no-op in this implementation
            break;

          default:
            break;
        }
      });
    });
  });
}
