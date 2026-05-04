-- AddColumn customer_type to chapan_orders
ALTER TABLE "chapan_orders" ADD COLUMN "customer_type" TEXT NOT NULL DEFAULT 'retail';
