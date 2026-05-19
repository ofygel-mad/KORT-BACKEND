CREATE TABLE "kaspi_connections" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "seller_name" TEXT,
    "api_token" TEXT NOT NULL,
    "token_last4" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_checked_at" TIMESTAMP(3),
    "last_sync_at" TIMESTAMP(3),
    "last_sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kaspi_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "kaspi_order_links" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "external_order_code" TEXT,
    "external_state" TEXT,
    "external_status" TEXT,
    "external_delivery_mode" TEXT,
    "internal_order_id" TEXT,
    "internal_order_type" TEXT,
    "raw_payload" JSONB,
    "last_external_update_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kaspi_order_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "kaspi_connections_org_id_key" ON "kaspi_connections"("org_id");
CREATE UNIQUE INDEX "kaspi_order_links_org_id_external_order_id_key" ON "kaspi_order_links"("org_id", "external_order_id");
CREATE INDEX "kaspi_order_links_org_id_external_status_idx" ON "kaspi_order_links"("org_id", "external_status");
CREATE INDEX "kaspi_order_links_org_id_external_state_idx" ON "kaspi_order_links"("org_id", "external_state");
CREATE INDEX "kaspi_order_links_org_id_internal_order_id_idx" ON "kaspi_order_links"("org_id", "internal_order_id");
CREATE INDEX "kaspi_order_links_connection_id_last_synced_at_idx" ON "kaspi_order_links"("connection_id", "last_synced_at");

ALTER TABLE "kaspi_connections" ADD CONSTRAINT "kaspi_connections_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kaspi_order_links" ADD CONSTRAINT "kaspi_order_links_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "kaspi_order_links" ADD CONSTRAINT "kaspi_order_links_connection_id_fkey"
FOREIGN KEY ("connection_id") REFERENCES "kaspi_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
