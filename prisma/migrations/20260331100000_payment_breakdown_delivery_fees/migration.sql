-- AlterTable: ChapanOrder — add payment_breakdown JSON column
ALTER TABLE "chapan_orders" ADD COLUMN "payment_breakdown" JSONB;

-- AlterTable: ChapanProfile — add delivery fee columns
ALTER TABLE "chapan_profiles" ADD COLUMN "kazpost_delivery_fee" INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE "chapan_profiles" ADD COLUMN "rail_delivery_fee" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "chapan_profiles" ADD COLUMN "air_delivery_fee" INTEGER NOT NULL DEFAULT 5000;
