ALTER TABLE "kaspi_connections"
ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMP(3);

DROP INDEX IF EXISTS "kaspi_connections_org_id_key";
CREATE INDEX IF NOT EXISTS "kaspi_connections_org_id_is_active_idx"
ON "kaspi_connections"("org_id", "is_active");
CREATE INDEX IF NOT EXISTS "kaspi_connections_org_id_archived_at_idx"
ON "kaspi_connections"("org_id", "archived_at");

DROP INDEX IF EXISTS "kaspi_order_links_org_id_external_order_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "kaspi_order_links_connection_id_external_order_id_key"
ON "kaspi_order_links"("connection_id", "external_order_id");
CREATE INDEX IF NOT EXISTS "kaspi_order_links_org_id_connection_id_idx"
ON "kaspi_order_links"("org_id", "connection_id");
