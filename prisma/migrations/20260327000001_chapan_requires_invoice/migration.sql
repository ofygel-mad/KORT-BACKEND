-- AddColumn: requiresInvoice to chapan_orders
-- Default true preserves existing behavior (all current orders require invoice)
ALTER TABLE "chapan_orders" ADD COLUMN "requires_invoice" BOOLEAN NOT NULL DEFAULT true;
