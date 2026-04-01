import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';

const prisma = new PrismaClient();
const RECOVERABLE_MIGRATION = '20260401000000_add_chat';
const REQUIRED_CHAT_TABLES = ['conversations', 'conversation_participants', 'messages'];

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function hasMigrationsTable() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS exists`,
  );

  return Array.isArray(rows) && rows[0]?.exists === true;
}

async function hasFailedChatMigration() {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT 1
      FROM "_prisma_migrations"
      WHERE migration_name = $1
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
      LIMIT 1
    `,
    RECOVERABLE_MIGRATION,
  );

  return Array.isArray(rows) && rows.length > 0;
}

async function hasChatTables() {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('conversations', 'conversation_participants', 'messages')
    `,
  );

  return Array.isArray(rows) && rows.length === REQUIRED_CHAT_TABLES.length;
}

async function recoverKnownFailedMigration() {
  if (!(await hasMigrationsTable())) {
    return;
  }

  if (!(await hasFailedChatMigration())) {
    return;
  }

  if (!(await hasChatTables())) {
    return;
  }

  console.log(`Recovering failed migration ${RECOVERABLE_MIGRATION} before deploy.`);
  run('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--rolled-back', RECOVERABLE_MIGRATION]);
}

async function main() {
  try {
    await recoverKnownFailedMigration();
  } finally {
    await prisma.$disconnect();
  }

  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy']);
  run('pnpm', ['run', 'db:seed']);
  run('node', ['dist/index.js']);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
