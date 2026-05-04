-- Create table for unpaid order alerts
CREATE TABLE "chapan_unpaid_alerts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,

    CONSTRAINT "chapan_unpaid_alerts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "chapan_unpaid_alerts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "chapan_unpaid_alerts_org_id_idx" ON "chapan_unpaid_alerts"("org_id");
CREATE INDEX "chapan_unpaid_alerts_order_id_idx" ON "chapan_unpaid_alerts"("order_id");
CREATE INDEX "chapan_unpaid_alerts_resolved_at_idx" ON "chapan_unpaid_alerts"("resolved_at");
