import { defineConfig } from 'prisma/config';
import { config } from 'dotenv';

// Load .env manually — prisma.config.ts bypasses Prisma's automatic .env loading
config();

export default defineConfig({
  earlyAccess: true,
  schema: 'prisma/schema.prisma',
});
