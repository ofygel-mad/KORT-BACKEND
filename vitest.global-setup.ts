import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';

config({ path: resolve('.env.test') });

function syncTestDatabase() {
  try {
    execSync('pnpm exec prisma migrate deploy', {
      cwd: resolve('.'),
      env: process.env,
      stdio: 'pipe',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('P3005')) {
      throw error;
    }

    execSync('pnpm exec prisma db push', {
      cwd: resolve('.'),
      env: process.env,
      stdio: 'pipe',
    });
  }
}

export default async function globalSetup() {
  syncTestDatabase();
}
