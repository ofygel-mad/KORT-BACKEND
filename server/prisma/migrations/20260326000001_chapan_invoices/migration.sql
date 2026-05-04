-- AlterTable: Add invoiceCounter to chapan_profiles
ALTER TABLE "chapan_profiles" ADD COLUMN "invoice_counter" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: chapan_invoices
CREATE TABLE "chapan_invoices" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending_confirmation',
    "created_by_id" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "seamstress_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "seamstress_confirmed_at" TIMESTAMP(3),
    "seamstress_confirmed_by" TEXT,
    "warehouse_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "warehouse_confirmed_at" TIMESTAMP(3),
    "warehouse_confirmed_by" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejected_by" TEXT,
    "rejection_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapan_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chapan_invoice_orders
CREATE TABLE "chapan_invoice_orders" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,

    CONSTRAINT "chapan_invoice_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chapan_invoices_org_id_status_idx" ON "chapan_invoices"("org_id", "status");
CREATE INDEX "chapan_invoices_org_id_created_at_idx" ON "chapan_invoices"("org_id", "created_at");
CREATE INDEX "chapan_invoice_orders_order_id_idx" ON "chapan_invoice_orders"("order_id");
CREATE UNIQUE INDEX "chapan_invoice_orders_invoice_id_order_id_key" ON "chapan_invoice_orders"("invoice_id", "order_id");

-- AddForeignKey
ALTER TABLE "chapan_invoices" ADD CONSTRAINT "chapan_invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chapan_invoice_orders" ADD CONSTRAINT "chapan_invoice_orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "chapan_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chapan_invoice_orders" ADD CONSTRAINT "chapan_invoice_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Migrate existing 'transferred' orders to 'on_warehouse'
UPDATE "chapan_orders" SET "status" = 'on_warehouse' WHERE "status" = 'transferred';
