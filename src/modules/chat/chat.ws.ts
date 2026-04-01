/**
 * chat.ws.ts — WebSocket layer for real-time chat
 *
 * Strategy: raw `ws` WebSocketServer attached to the Fastify HTTP server
 * via the Node.js `upgrade` event. No @fastify/websocket needed.
 *
 * Connection URL: ws(s)://host/api/v1/ws/chat?token=<accessToken>
 *
 * Events pushed to client:
 *   { type: 'message.new',     conversation_id, message, unread_count }
 *   { type: 'message.read',    conversation_id, reader_id, read_at }
 *   { type: 'presence.update', user_id, status }
 *   { type: 'ping' }   ← server heartbeat (client may ignore)
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server as HttpServer } from 'http';
import { verifyAccessToken } from '../../lib/jwt.js';

// ── Connection registry ────────────────────────────────────────────────────
const connections = new Map<string, Set<WebSocket>>();

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a JSON event to ALL active sockets for a given userId.
 * Silently skips closed/unavailable sockets.
 */
export function broadcastToUser(userId: string, event: object) {
  const sockets = connections.get(userId);
  if (!sockets?.size) return;
  const payload = JSON.stringify(event);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Attach the WebSocket server to an existing Node.js HTTP server.
 * Must be called after `app.listen()` so the server object is ready.
 */
export function attachChatWebSocket(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // Only handle our chat endpoint
    if (url.pathname !== '/api/v1/ws/chat') {
      socket.destroy();
      return;
    }

    // Token auth via query param (WS can't set Authorization header)
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

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Register
      if (!connections.has(userId)) connections.set(userId, new Set());
      connections.get(userId)!.add(ws);

      // Confirm connection
      ws.send(JSON.stringify({ type: 'connected', user_id: userId }));

      // Heartbeat ping every 25s to prevent proxy timeouts
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
          set.delete(ws);
          if (set.size === 0) connections.delete(userId);
        }
      }

      ws.on('close', cleanup);
      ws.on('error', cleanup);

      // Clients may send pong back or nothing — we accept and ignore all messages
      ws.on('message', () => { /* client messages not used in this phase */ });
    });
  });
}
