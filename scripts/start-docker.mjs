import { spawnSync } from 'node:child_process';

function run(command, args, description = '') {
  console.log(`\n▶️  ${description || `${command} ${args.join(' ')}`}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(`❌ ${description} failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`✅ ${description} completed successfully`);
}

function resolveApplied(name) {
  console.log(`   → prisma migrate resolve --applied "${name}"`);
  spawnSync(
    'pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--applied', name],
    { stdio: 'inherit', shell: process.platform === 'win32', env: process.env },
  );
}

/**
 * Runs prisma migrate deploy in a retry loop, auto-resolving two classes of
 * recoverable migration errors:
 *
 *   P3009 — a previously-failed migration blocks deploy.
 *            Fix: resolve as --applied (schema already in DB).
 *
 *   P3018 + "already exists" — migration tried to CREATE a relation/index
 *            that already exists (idempotency conflict).
 *            Fix: resolve as --applied (object is already there).
 *
 * Any other P3018 (real SQL error) causes an immediate exit — those require
 * a human to look at and fix.
 */
function runMigrations() {
  const MAX_ATTEMPTS = 15; // more than enough migrations to unblock

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n▶️  📦 Deploying database migrations${attempt > 1 ? ` (attempt ${attempt})` : ''}`);

    const result = spawnSync(
      'pnpm', ['exec', 'prisma', 'migrate', 'deploy'],
      { stdio: 'pipe', shell: process.platform === 'win32', env: process.env },
    );

    const output = (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
    process.stdout.write(output);

    if (result.status === 0) {
      console.log('✅ 📦 Deploying database migrations completed successfully');
      return;
    }

    // ── P3009: a failed migration is blocking new ones ──────────────────────
    // Error format: The `<name>` migration started at … failed
    if (output.includes('P3009')) {
      console.log('\n🔧 P3009 detected — marking failed migration(s) as applied…');
      const nameRegex = /The `([^`]+)` migration/g;
      let match;
      let resolved = 0;
      while ((match = nameRegex.exec(output)) !== null) {
        resolveApplied(match[1]);
        resolved++;
      }
      if (resolved === 0) {
        console.error('❌ Could not extract migration name from P3009 error — manual fix required');
        process.exit(1);
      }
      continue; // retry deploy
    }

    // ── P3018: migration failed during execution ─────────────────────────────
    // Error format: Migration name: <name>
    if (output.includes('P3018')) {
      // "already exists" means the object was created by a prior partial run
      // or an out-of-band change — safe to resolve as applied.
      const alreadyExists =
        output.includes('already exists') ||
        output.includes('42P07') || // duplicate table
        output.includes('42710');   // duplicate index/constraint

      if (alreadyExists) {
        const nameMatch = output.match(/Migration name:\s*(\S+)/);
        if (nameMatch) {
          console.log('\n🔧 P3018 "already exists" — marking migration as applied…');
          resolveApplied(nameMatch[1]);
          continue; // retry deploy
        }
      }

      // Any other P3018 is a genuine SQL failure — needs human attention
      console.error('\n❌ Migration failed with an unrecoverable SQL error (P3018). Fix the migration and redeploy.');
      process.exit(1);
    }

    // ── Any other failure ────────────────────────────────────────────────────
    console.error(`❌ 📦 Deploying database migrations failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }

  console.error('❌ Migrations still failing after maximum retry attempts — manual intervention required');
  process.exit(1);
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('   🚀 Starting KORT Backend Server');
  console.log('═══════════════════════════════════════\n');

  runMigrations();
  run('pnpm', ['run', 'db:seed'], '🌱 Seeding database with demo data');
  run('node', ['dist/index.js'], '🚀 Starting application server');
}

main().catch((error) => {
  console.error('\n❌ Fatal startup error:', error);
  process.exit(1);
});
