-- Performance indexes for chapan_orders: common filter/sort columns
CREATE INDEX IF NOT EXISTS "chapan_orders_org_id_payment_status_idx" ON "chapan_orders"("org_id", "payment_status");
CREATE INDEX IF NOT EXISTS "chapan_orders_org_id_is_archived_idx"    ON "chapan_orders"("org_id", "is_archived");
CREATE INDEX IF NOT EXISTS "chapan_orders_client_id_idx"             ON "chapan_orders"("client_id");

-- Compound index for production tasks: filter by order + status in one scan
CREATE INDEX IF NOT EXISTS "chapan_production_tasks_order_id_status_idx" ON "chapan_production_tasks"("order_id", "status");

-- Activity log: sorted queries by createdAt within an order
CREATE INDEX IF NOT EXISTS "chapan_activities_order_id_created_at_idx" ON "chapan_activities"("order_id", "created_at");
