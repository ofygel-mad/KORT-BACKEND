-- CreateTable
CREATE TABLE "chapan_change_requests" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "proposed_items" JSONB NOT NULL,
    "manager_note" TEXT,
    "reject_reason" TEXT,
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapan_change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chapan_change_requests_order_id_idx" ON "chapan_change_requests"("order_id");

-- CreateIndex
CREATE INDEX "chapan_change_requests_org_id_status_idx" ON "chapan_change_requests"("org_id", "status");

-- AddForeignKey
ALTER TABLE "chapan_change_requests" ADD CONSTRAINT "chapan_change_requests_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
