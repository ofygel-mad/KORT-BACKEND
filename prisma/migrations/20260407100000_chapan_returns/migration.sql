-- AlterTable: add has_returns flag to chapan_orders
ALTER TABLE "chapan_orders" ADD COLUMN "has_returns" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: chapan_returns
CREATE TABLE "chapan_returns" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "return_number" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reason" TEXT NOT NULL,
    "reason_notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" TEXT,
    "total_refund_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refund_method" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "chapan_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable: chapan_return_items
CREATE TABLE "chapan_return_items" (
    "id" TEXT NOT NULL,
    "return_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "product_name" TEXT NOT NULL,
    "size" TEXT NOT NULL,
    "fabric" TEXT,
    "color" TEXT,
    "gender" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DOUBLE PRECISION NOT NULL,
    "refund_amount" DOUBLE PRECISION NOT NULL,
    "condition" TEXT NOT NULL DEFAULT 'good',
    "warehouse_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chapan_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chapan_returns_org_id_return_number_key" ON "chapan_returns"("org_id", "return_number");
CREATE INDEX "chapan_returns_org_id_status_idx" ON "chapan_returns"("org_id", "status");
CREATE INDEX "chapan_returns_org_id_order_id_idx" ON "chapan_returns"("org_id", "order_id");
CREATE INDEX "chapan_returns_org_id_created_at_idx" ON "chapan_returns"("org_id", "created_at");
CREATE INDEX "chapan_return_items_return_id_idx" ON "chapan_return_items"("return_id");

-- AddForeignKey
ALTER TABLE "chapan_returns" ADD CONSTRAINT "chapan_returns_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chapan_returns" ADD CONSTRAINT "chapan_returns_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chapan_return_items" ADD CONSTRAINT "chapan_return_items_return_id_fkey"
    FOREIGN KEY ("return_id") REFERENCES "chapan_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
