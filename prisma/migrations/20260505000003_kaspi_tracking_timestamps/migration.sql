ALTER TABLE "kaspi_order_links"
ADD COLUMN "accepted_at" TIMESTAMP(3),
ADD COLUMN "completed_at" TIMESTAMP(3),
ADD COLUMN "cancelled_at" TIMESTAMP(3);
