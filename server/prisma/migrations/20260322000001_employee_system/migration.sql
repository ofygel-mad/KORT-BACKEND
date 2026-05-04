-- ============================================================
-- Migration: Employee system + Extended org profile
-- ============================================================

-- 1. Make User.email nullable (phone-only employees have no email)
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- 2. Add unique index on users.phone (NULL values are excluded from uniqueness check in PostgreSQL)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_col_added" BOOLEAN DEFAULT FALSE;
-- phone already exists, just add unique constraint safely
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_key'
  ) THEN
    CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone") WHERE "phone" IS NOT NULL;
  END IF;
END $$;

-- 3. Extend memberships with employee fields
ALTER TABLE "memberships"
  ADD COLUMN IF NOT EXISTS "department"               TEXT         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "employee_permissions"     TEXT[]       NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "added_by_id"              TEXT,
  ADD COLUMN IF NOT EXISTS "added_by_name"            TEXT,
  ADD COLUMN IF NOT EXISTS "employee_account_status"  TEXT         NOT NULL DEFAULT 'active';

-- 4. Update memberships.source: add 'admin_added' as valid source value
--    (no constraint to alter since source is TEXT without check constraint)

-- 5. Extend organizations with full profile fields
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "legal_name"   TEXT,
  ADD COLUMN IF NOT EXISTS "bin"          TEXT,
  ADD COLUMN IF NOT EXISTS "iin"          TEXT,
  ADD COLUMN IF NOT EXISTS "legal_form"   TEXT,
  ADD COLUMN IF NOT EXISTS "director"     TEXT,
  ADD COLUMN IF NOT EXISTS "accountant"   TEXT,
  ADD COLUMN IF NOT EXISTS "address"      TEXT,
  ADD COLUMN IF NOT EXISTS "city"         TEXT,
  ADD COLUMN IF NOT EXISTS "phone"        TEXT,
  ADD COLUMN IF NOT EXISTS "email"        TEXT,
  ADD COLUMN IF NOT EXISTS "website"      TEXT,
  ADD COLUMN IF NOT EXISTS "bank_name"    TEXT,
  ADD COLUMN IF NOT EXISTS "bank_bik"     TEXT,
  ADD COLUMN IF NOT EXISTS "bank_account" TEXT;

-- 6. Backfill: existing employees (non-owner members) default to active status
UPDATE "memberships"
SET "employee_account_status" = 'active'
WHERE "employee_account_status" = '';
