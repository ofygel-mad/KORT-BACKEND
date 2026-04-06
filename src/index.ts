import { config } from './config.js';
import { buildApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './lib/prisma.js';
import { attachChatWebSocket, broadcastToUser } from './modules/chat/chat.ws.js';
import { setChatEventEmitter } from './modules/chat/chat.service.js';
import { startWarehouseOutboxWorker } from './modules/warehouse/warehouse-outbox.worker.js';

async function main() {
  await connectDatabase();

  const app = await buildApp();
  let warehouseOutboxWorker: ReturnType<typeof startWarehouseOutboxWorker> | null = null;

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info({ origins: config.CORS_ORIGINS }, 'CORS origins configured');
    console.log(`Server running at http://${config.HOST}:${config.PORT}`);

    // Wire real-time chat WebSocket on ws://host/api/v1/ws/chat?token=<jwt>
    attachChatWebSocket(app.server);
    setChatEventEmitter(broadcastToUser);
    app.log.info('Chat WebSocket attached at /api/v1/ws/chat');

    warehouseOutboxWorker = startWarehouseOutboxWorker(app.log);
    app.log.info('Warehouse outbox worker started');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;

    if (err?.code === 'EADDRINUSE') {
      app.log.error(
        { host: config.HOST, port: config.PORT },
        `Port ${config.PORT} is already in use. Another backend process is already running.`,
      );
    } else {
      app.log.error(error);
    }

    await disconnectDatabase();
    process.exit(1);
  }

  const shutdown = async () => {
    console.log('\nShutting down...');
    warehouseOutboxWorker?.stop();
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
