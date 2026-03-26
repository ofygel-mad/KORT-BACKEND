import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

loadEnv({ path: resolve(__dirname, '../.env') });

export function normalizeCorsOrigin(origin: string) {
  return origin.trim().replace(/\/+$/, '');
}

function parseCorsOrigins(value: string) {
  return [...new Set(
    value
      .split(',')
      .map((origin) => normalizeCorsOrigin(origin))
      .filter(Boolean),
  )];
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  PORT: z.coerce.number().default(8000),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  CONSOLE_SERVICE_PASSWORD: z.string().optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const corsOrigins = parseCorsOrigins(parsed.data.CORS_ORIGIN);

  if (corsOrigins.length === 0) {
    console.error('Invalid environment variables:', { CORS_ORIGIN: ['Provide at least one allowed origin'] });
    process.exit(1);
  }

  return {
    ...parsed.data,
    CORS_ORIGINS: corsOrigins,
  };
}

export const config = loadConfig();
export type Config = typeof config;
