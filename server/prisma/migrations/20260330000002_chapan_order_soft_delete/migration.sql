-- AlterTable: soft-delete field for chapan orders (trash bin)
ALTER TABLE "chapan_orders" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Index for efficient trash queries
CREATE INDEX "chapan_orders_deleted_at_idx" ON "chapan_orders"("deleted_at") WHERE "deleted_at" IS NOT NULL;
