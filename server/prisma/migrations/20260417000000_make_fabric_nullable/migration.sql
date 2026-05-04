-- Make fabric column optional on order items and production tasks
-- Fabric selection was removed from the order form; only color remains.
ALTER TABLE "chapan_order_items" ALTER COLUMN "fabric" DROP NOT NULL;
ALTER TABLE "chapan_production_tasks" ALTER COLUMN "fabric" DROP NOT NULL;
