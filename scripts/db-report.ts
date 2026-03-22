/**
 * db-report.ts
 * Full database dump to CSV for debugging.
 *
 * Usage: pnpm run db:report
 *
 * Output: <project-root>/_database-report/<YYYY-MM-DD_HH-mm-ss>/
 *   Each table → its own .csv file (all columns, no filtering).
 *   _summary.txt → row counts + timing.
 */

import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

// ── Bootstrap ────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '../.env') });

const prisma = new PrismaClient();

// ── Helpers ──────────────────────────────────────────────────

/** Escapes a single CSV cell value */
function csvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) return csvCell(JSON.stringify(val));
  const s = String(val);
  // Wrap in quotes if the value contains commas, quotes or newlines
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Converts an array of objects to a CSV string */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(empty table)\n';
  const headers = Object.keys(rows[0]);
  const lines: string[] = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(',')),
  ];
  return lines.join('\n') + '\n';
}

/** Writes a CSV file and returns the row count */
function writeCsv(dir: string, filename: string, rows: Record<string, unknown>[]): number {
  const content = toCsv(rows);
  writeFileSync(resolve(dir, filename), content, 'utf-8');
  return rows.length;
}

/** Zero-pad a number */
function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** YYYY-MM-DD_HH-mm-ss */
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const ts = timestamp();

  // Output directory: <project-root>/_database-report/<timestamp>/
  const reportRoot = resolve(__dirname, '../../_database-report');
  const outDir = resolve(reportRoot, ts);

  if (!existsSync(reportRoot)) mkdirSync(reportRoot, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`\n  DB Report — ${ts}`);
  console.log(`  Output: ${outDir}\n`);

  const counts: Record<string, number> = {};

  // ── AUTH & IDENTITY ──────────────────────────────────────

  counts.users = writeCsv(outDir, 'users.csv',
    (await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.refresh_tokens = writeCsv(outDir, 'refresh_tokens.csv',
    (await prisma.refreshToken.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  // ── ORGANIZATIONS & MEMBERSHIPS ──────────────────────────

  counts.organizations = writeCsv(outDir, 'organizations.csv',
    (await prisma.organization.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.memberships = writeCsv(outDir, 'memberships.csv',
    (await prisma.membership.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.invites = writeCsv(outDir, 'invites.csv',
    (await prisma.invite.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.membership_requests = writeCsv(outDir, 'membership_requests.csv',
    (await prisma.membershipRequest.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  // ── CRM ──────────────────────────────────────────────────

  counts.customers = writeCsv(outDir, 'customers.csv',
    (await prisma.customer.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.leads = writeCsv(outDir, 'leads.csv',
    (await prisma.lead.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.lead_history = writeCsv(outDir, 'lead_history.csv',
    (await prisma.leadHistory.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.deals = writeCsv(outDir, 'deals.csv',
    (await prisma.deal.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.deal_activities = writeCsv(outDir, 'deal_activities.csv',
    (await prisma.dealActivity.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.tasks = writeCsv(outDir, 'tasks.csv',
    (await prisma.task.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.task_subtasks = writeCsv(outDir, 'task_subtasks.csv',
    (await prisma.taskSubtask.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.task_activities = writeCsv(outDir, 'task_activities.csv',
    (await prisma.taskActivity.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  // ── CHAPAN WORKSHOP ──────────────────────────────────────

  counts.chapan_profiles = writeCsv(outDir, 'chapan_profiles.csv',
    (await prisma.chapanProfile.findMany()) as Record<string, unknown>[]);

  counts.chapan_workers = writeCsv(outDir, 'chapan_workers.csv',
    (await prisma.chapanWorker.findMany()) as Record<string, unknown>[]);

  counts.chapan_catalog_products = writeCsv(outDir, 'chapan_catalog_products.csv',
    (await prisma.chapanCatalogProduct.findMany()) as Record<string, unknown>[]);

  counts.chapan_catalog_fabrics = writeCsv(outDir, 'chapan_catalog_fabrics.csv',
    (await prisma.chapanCatalogFabric.findMany()) as Record<string, unknown>[]);

  counts.chapan_catalog_sizes = writeCsv(outDir, 'chapan_catalog_sizes.csv',
    (await prisma.chapanCatalogSize.findMany()) as Record<string, unknown>[]);

  counts.chapan_clients = writeCsv(outDir, 'chapan_clients.csv',
    (await prisma.chapanClient.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.chapan_requests = writeCsv(outDir, 'chapan_requests.csv',
    (await prisma.chapanRequest.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.chapan_request_items = writeCsv(outDir, 'chapan_request_items.csv',
    (await prisma.chapanRequestItem.findMany()) as Record<string, unknown>[]);

  counts.chapan_orders = writeCsv(outDir, 'chapan_orders.csv',
    (await prisma.chapanOrder.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  counts.chapan_order_items = writeCsv(outDir, 'chapan_order_items.csv',
    (await prisma.chapanOrderItem.findMany()) as Record<string, unknown>[]);

  counts.chapan_production_tasks = writeCsv(outDir, 'chapan_production_tasks.csv',
    (await prisma.chapanProductionTask.findMany()) as Record<string, unknown>[]);

  counts.chapan_payments = writeCsv(outDir, 'chapan_payments.csv',
    (await prisma.chapanPayment.findMany()) as Record<string, unknown>[]);

  counts.chapan_transfers = writeCsv(outDir, 'chapan_transfers.csv',
    (await prisma.chapanTransfer.findMany()) as Record<string, unknown>[]);

  counts.chapan_activities = writeCsv(outDir, 'chapan_activities.csv',
    (await prisma.chapanActivity.findMany({ orderBy: { createdAt: 'asc' } })) as Record<string, unknown>[]);

  // ── Summary ───────────────────────────────────────────────

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const tableCount = Object.keys(counts).length;

  const colW = 36;
  const summaryLines: string[] = [
    `DB Report`,
    `Generated: ${new Date().toISOString()}`,
    `Duration:  ${elapsed}s`,
    ``,
    `${'Table'.padEnd(colW)} Rows`,
    `${'-'.repeat(colW + 8)}`,
    ...Object.entries(counts).map(
      ([table, rows]) => `${table.padEnd(colW)} ${rows}`,
    ),
    `${'-'.repeat(colW + 8)}`,
    `${'TOTAL'.padEnd(colW)} ${totalRows} rows across ${tableCount} tables`,
  ];

  writeFileSync(resolve(outDir, '_summary.txt'), summaryLines.join('\n') + '\n', 'utf-8');

  // Console output
  const nameW = 32;
  for (const [table, rows] of Object.entries(counts)) {
    const label = rows === 0 ? '(empty)' : `${rows} rows`;
    console.log(`  ${'✓'.padEnd(3)} ${table.padEnd(nameW)} ${label}`);
  }

  console.log(`\n  ${tableCount} tables · ${totalRows} rows · ${elapsed}s`);
  console.log(`  Saved to: _database-report/${ts}/\n`);
}

main()
  .catch((err) => {
    console.error('\n  ✗ Report failed:', err.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
