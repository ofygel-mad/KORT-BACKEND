import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';

const prisma = new PrismaClient();
const RECOVERABLE_MIGRATION = '20260401000000_add_chat';
const PERF_INDEXES_MIGRATION = '20260402000000_add_performance_indexes';
const REQUIRED_CHAT_TABLES = ['conversations', 'conversation_participants', 'messages'];
const REQUIRED_PERF_INDEXES = [
  'chapan_orders_org_id_payment_status_idx',
  'chapan_orders_org_id_is_archived_idx',
  'chapan_orders_client_id_idx',
  'chapan_production_tasks_order_id_status_idx',
  'chapan_activities_order_id_created_at_idx',
];

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

async function hasFailedMigration(name) {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT 1
      FROM "_prisma_migrations"
      WHERE migration_name = $1
        AND finished_at IS NULL
        AND rolled_back_at IS NULL
      LIMIT 1
    `,
    name,
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

async function hasPerformanceIndexes() {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY ($1)
    `,
    REQUIRED_PERF_INDEXES,
  );

  return Array.isArray(rows) && rows.length === REQUIRED_PERF_INDEXES.length;
}

async function recoverKnownFailedMigration() {
  if (!(await hasMigrationsTable())) {
    return;
  }

  if (await hasFailedChatMigration()) {
    if (!(await hasChatTables())) {
      return;
    }

    console.log(`Recovering failed migration ${RECOVERABLE_MIGRATION} before deploy.`);
    run('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--rolled-back', RECOVERABLE_MIGRATION]);
  }

  if (await hasFailedMigration(PERF_INDEXES_MIGRATION)) {
    if (await hasPerformanceIndexes()) {
      console.log(`Marking ${PERF_INDEXES_MIGRATION} as applied (indexes already exist).`);
      run('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--applied', PERF_INDEXES_MIGRATION]);
    } else {
      console.log(`Rolling back failed ${PERF_INDEXES_MIGRATION} so it can re-run.`);
      run('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--rolled-back', PERF_INDEXES_MIGRATION]);
    }
  }
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
