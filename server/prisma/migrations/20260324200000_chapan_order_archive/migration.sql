-- Add archive fields to chapan_orders
ALTER TABLE "chapan_orders" ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chapan_orders" ADD COLUMN "archived_at" TIMESTAMP(3);
