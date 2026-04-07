-- Add manager tracking to ChapanOrder
-- manager_id / manager_name: the user who is credited with this order (for salary/bonus calculations).
-- Nullable for backward compat — existing orders before this migration have no known manager.

ALTER TABLE "chapan_orders"
  ADD COLUMN "manager_id"   TEXT,
  ADD COLUMN "manager_name" TEXT;
