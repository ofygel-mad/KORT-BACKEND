-- Migration: Split priority into urgency + isDemandingClient
-- Sprint 2 (B1): Separate urgency from demanding-client flag

ALTER TABLE "chapan_orders"
  ADD COLUMN "urgency" TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN "is_demanding_client" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: urgent → urgency='urgent', vip → isDemandingClient=true
UPDATE "chapan_orders" SET "urgency" = 'urgent'          WHERE "priority" = 'urgent';
UPDATE "chapan_orders" SET "is_demanding_client" = true  WHERE "priority" = 'vip';
