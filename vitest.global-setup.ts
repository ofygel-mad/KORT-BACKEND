import { config } from 'dotenv';
import { resolve } from 'path';
import { execSync } from 'child_process';

config({ path: resolve('.env.test') });

export default async function globalSetup() {
  execSync('pnpm exec prisma migrate deploy', {
    cwd: resolve('.'),
    env: process.env,
    stdio: 'pipe',
  });
}
