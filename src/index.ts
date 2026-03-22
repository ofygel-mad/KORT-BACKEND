import { config } from './config.js';
import { buildApp } from './app.js';
import { connectDatabase, disconnectDatabase } from './lib/prisma.js';

async function main() {
  await connectDatabase();

  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    console.log(`Server running at http://${config.HOST}:${config.PORT}`);
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
    await app.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
