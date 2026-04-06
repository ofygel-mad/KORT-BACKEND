-- CreateTable
CREATE TABLE "warehouse_sites" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "published_layout_version_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_zones" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "parent_zone_id" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone_type" TEXT NOT NULL DEFAULT 'storage',
    "status" TEXT NOT NULL DEFAULT 'active',
    "capacity_policy_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_aisles" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "direction_policy" TEXT DEFAULT 'bidirectional',
    "min_width_mm" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_aisles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_racks" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "aisle_id" TEXT,
    "code" TEXT NOT NULL,
    "rack_type" TEXT NOT NULL DEFAULT 'standard',
    "status" TEXT NOT NULL DEFAULT 'active',
    "max_weight" DOUBLE PRECISION,
    "max_volume" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_racks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_shelves" (
    "id" TEXT NOT NULL,
    "rack_id" TEXT NOT NULL,
    "level_index" INTEGER NOT NULL,
    "max_weight" DOUBLE PRECISION,
    "max_volume" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_shelves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_bins" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "aisle_id" TEXT,
    "rack_id" TEXT,
    "shelf_id" TEXT,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "bin_type" TEXT NOT NULL DEFAULT 'standard',
    "capacity_units" DOUBLE PRECISION,
    "capacity_weight" DOUBLE PRECISION,
    "capacity_volume" DOUBLE PRECISION,
    "pick_face_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_bins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_variants" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_catalog_id" TEXT NOT NULL,
    "variant_key" TEXT NOT NULL,
    "attributes_json" JSONB,
    "attributes_summary" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_ledger_events" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "from_bin_id" TEXT,
    "to_bin_id" TEXT,
    "event_type" TEXT NOT NULL,
    "qty_delta" DOUBLE PRECISION NOT NULL,
    "stock_status_from" TEXT,
    "stock_status_to" TEXT,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_line_id" TEXT,
    "correlation_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "actor_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stock_ledger_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_balances" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "bin_id" TEXT NOT NULL,
    "stock_status" TEXT NOT NULL,
    "qty_on_hand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_available" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_reservations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_line_id" TEXT,
    "qty_reserved" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "idempotency_key" TEXT NOT NULL,
    "compatibility_reservation_id" TEXT,
    "released_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_stock_reservation_allocations" (
    "id" TEXT NOT NULL,
    "reservation_id" TEXT NOT NULL,
    "stock_balance_id" TEXT NOT NULL,
    "bin_id" TEXT NOT NULL,
    "qty_reserved" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_stock_reservation_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_layout_versions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "based_on_version_id" TEXT,
    "published_at" TIMESTAMP(3),
    "created_by" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_layout_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_operation_documents" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT,
    "order_id" TEXT,
    "document_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'posted',
    "idempotency_key" TEXT NOT NULL,
    "reference_no" TEXT,
    "payload" JSONB,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_operation_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_order_read_models" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT,
    "snapshot_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'fresh',
    "last_event_id" TEXT,
    "last_event_type" TEXT,
    "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_order_read_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_outbox" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_projection_inbox" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT,
    "consumer" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processed',
    "payload_hash" TEXT,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_projection_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_sites_org_id_code_key" ON "warehouse_sites"("org_id", "code");
CREATE INDEX "warehouse_sites_org_id_status_idx" ON "warehouse_sites"("org_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_zones_warehouse_site_id_code_key" ON "warehouse_zones"("warehouse_site_id", "code");
CREATE INDEX "warehouse_zones_org_id_warehouse_site_id_status_idx" ON "warehouse_zones"("org_id", "warehouse_site_id", "status");
CREATE INDEX "warehouse_zones_parent_zone_id_idx" ON "warehouse_zones"("parent_zone_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_aisles_warehouse_site_id_code_key" ON "warehouse_aisles"("warehouse_site_id", "code");
CREATE INDEX "warehouse_aisles_org_id_warehouse_site_id_zone_id_status_idx" ON "warehouse_aisles"("org_id", "warehouse_site_id", "zone_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_racks_warehouse_site_id_code_key" ON "warehouse_racks"("warehouse_site_id", "code");
CREATE INDEX "warehouse_racks_org_id_warehouse_site_id_zone_id_status_idx" ON "warehouse_racks"("org_id", "warehouse_site_id", "zone_id", "status");
CREATE INDEX "warehouse_racks_aisle_id_idx" ON "warehouse_racks"("aisle_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_shelves_rack_id_level_index_key" ON "warehouse_shelves"("rack_id", "level_index");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_bins_warehouse_site_id_code_key" ON "warehouse_bins"("warehouse_site_id", "code");
CREATE INDEX "warehouse_bins_org_id_warehouse_site_id_zone_id_status_idx" ON "warehouse_bins"("org_id", "warehouse_site_id", "zone_id", "status");
CREATE INDEX "warehouse_bins_aisle_id_idx" ON "warehouse_bins"("aisle_id");
CREATE INDEX "warehouse_bins_rack_id_idx" ON "warehouse_bins"("rack_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_variants_org_id_product_catalog_id_variant_key_key" ON "warehouse_variants"("org_id", "product_catalog_id", "variant_key");
CREATE INDEX "warehouse_variants_org_id_is_active_idx" ON "warehouse_variants"("org_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_ledger_events_org_id_idempotency_key_key" ON "warehouse_stock_ledger_events"("org_id", "idempotency_key");
CREATE INDEX "warehouse_stock_ledger_events_org_id_warehouse_site_id_created_at_idx" ON "warehouse_stock_ledger_events"("org_id", "warehouse_site_id", "created_at");
CREATE INDEX "warehouse_stock_ledger_events_org_id_variant_id_created_at_idx" ON "warehouse_stock_ledger_events"("org_id", "variant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_balances_org_id_warehouse_site_id_variant_id_bin_i_key" ON "warehouse_stock_balances"("org_id", "warehouse_site_id", "variant_id", "bin_id", "stock_status");
CREATE INDEX "warehouse_stock_balances_org_id_warehouse_site_id_bin_id_idx" ON "warehouse_stock_balances"("org_id", "warehouse_site_id", "bin_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_stock_reservations_org_id_idempotency_key_key" ON "warehouse_stock_reservations"("org_id", "idempotency_key");
CREATE INDEX "warehouse_stock_reservations_org_id_warehouse_site_id_status_idx" ON "warehouse_stock_reservations"("org_id", "warehouse_site_id", "status");
CREATE INDEX "warehouse_stock_reservations_org_id_source_type_source_id_idx" ON "warehouse_stock_reservations"("org_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "warehouse_stock_reservation_allocations_reservation_id_idx" ON "warehouse_stock_reservation_allocations"("reservation_id");
CREATE INDEX "warehouse_stock_reservation_allocations_stock_balance_id_idx" ON "warehouse_stock_reservation_allocations"("stock_balance_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_layout_versions_warehouse_site_id_version_no_key" ON "warehouse_layout_versions"("warehouse_site_id", "version_no");
CREATE INDEX "warehouse_layout_versions_org_id_warehouse_site_id_state_idx" ON "warehouse_layout_versions"("org_id", "warehouse_site_id", "state");
CREATE INDEX "warehouse_layout_versions_based_on_version_id_idx" ON "warehouse_layout_versions"("based_on_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_operation_documents_org_id_idempotency_key_key" ON "warehouse_operation_documents"("org_id", "idempotency_key");
CREATE INDEX "warehouse_operation_documents_org_id_order_id_document_type_idx" ON "warehouse_operation_documents"("org_id", "order_id", "document_type");
CREATE INDEX "warehouse_operation_documents_org_id_warehouse_site_id_posted_at_idx" ON "warehouse_operation_documents"("org_id", "warehouse_site_id", "posted_at");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_order_read_models_org_id_order_id_key" ON "warehouse_order_read_models"("org_id", "order_id");
CREATE INDEX "warehouse_order_read_models_org_id_warehouse_site_id_refreshed_at_idx" ON "warehouse_order_read_models"("org_id", "warehouse_site_id", "refreshed_at");

-- CreateIndex
CREATE INDEX "warehouse_outbox_org_id_status_available_at_idx" ON "warehouse_outbox"("org_id", "status", "available_at");
CREATE INDEX "warehouse_outbox_org_id_aggregate_type_aggregate_id_idx" ON "warehouse_outbox"("org_id", "aggregate_type", "aggregate_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_projection_inbox_org_id_consumer_event_id_key" ON "warehouse_projection_inbox"("org_id", "consumer", "event_id");
CREATE INDEX "warehouse_projection_inbox_org_id_consumer_processed_at_idx" ON "warehouse_projection_inbox"("org_id", "consumer", "processed_at");

-- AddForeignKey
ALTER TABLE "warehouse_sites" ADD CONSTRAINT "warehouse_sites_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_zones" ADD CONSTRAINT "warehouse_zones_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_zones" ADD CONSTRAINT "warehouse_zones_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_zones" ADD CONSTRAINT "warehouse_zones_parent_zone_id_fkey" FOREIGN KEY ("parent_zone_id") REFERENCES "warehouse_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_aisles" ADD CONSTRAINT "warehouse_aisles_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_aisles" ADD CONSTRAINT "warehouse_aisles_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_aisles" ADD CONSTRAINT "warehouse_aisles_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_racks" ADD CONSTRAINT "warehouse_racks_aisle_id_fkey" FOREIGN KEY ("aisle_id") REFERENCES "warehouse_aisles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_shelves" ADD CONSTRAINT "warehouse_shelves_rack_id_fkey" FOREIGN KEY ("rack_id") REFERENCES "warehouse_racks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_aisle_id_fkey" FOREIGN KEY ("aisle_id") REFERENCES "warehouse_aisles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_rack_id_fkey" FOREIGN KEY ("rack_id") REFERENCES "warehouse_racks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_bins" ADD CONSTRAINT "warehouse_bins_shelf_id_fkey" FOREIGN KEY ("shelf_id") REFERENCES "warehouse_shelves"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_variants" ADD CONSTRAINT "warehouse_variants_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_variants" ADD CONSTRAINT "warehouse_variants_product_catalog_id_fkey" FOREIGN KEY ("product_catalog_id") REFERENCES "warehouse_product_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock_ledger_events" ADD CONSTRAINT "warehouse_stock_ledger_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_ledger_events" ADD CONSTRAINT "warehouse_stock_ledger_events_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_ledger_events" ADD CONSTRAINT "warehouse_stock_ledger_events_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "warehouse_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_ledger_events" ADD CONSTRAINT "warehouse_stock_ledger_events_from_bin_id_fkey" FOREIGN KEY ("from_bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_ledger_events" ADD CONSTRAINT "warehouse_stock_ledger_events_to_bin_id_fkey" FOREIGN KEY ("to_bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock_balances" ADD CONSTRAINT "warehouse_stock_balances_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_balances" ADD CONSTRAINT "warehouse_stock_balances_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_balances" ADD CONSTRAINT "warehouse_stock_balances_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "warehouse_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_balances" ADD CONSTRAINT "warehouse_stock_balances_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock_reservations" ADD CONSTRAINT "warehouse_stock_reservations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_reservations" ADD CONSTRAINT "warehouse_stock_reservations_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_reservations" ADD CONSTRAINT "warehouse_stock_reservations_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "warehouse_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_stock_reservation_allocations" ADD CONSTRAINT "warehouse_stock_reservation_allocations_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "warehouse_stock_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_reservation_allocations" ADD CONSTRAINT "warehouse_stock_reservation_allocations_stock_balance_id_fkey" FOREIGN KEY ("stock_balance_id") REFERENCES "warehouse_stock_balances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_stock_reservation_allocations" ADD CONSTRAINT "warehouse_stock_reservation_allocations_bin_id_fkey" FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_layout_versions" ADD CONSTRAINT "warehouse_layout_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_layout_versions" ADD CONSTRAINT "warehouse_layout_versions_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_layout_versions" ADD CONSTRAINT "warehouse_layout_versions_based_on_version_id_fkey" FOREIGN KEY ("based_on_version_id") REFERENCES "warehouse_layout_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_operation_documents" ADD CONSTRAINT "warehouse_operation_documents_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_operation_documents" ADD CONSTRAINT "warehouse_operation_documents_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_order_read_models" ADD CONSTRAINT "warehouse_order_read_models_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_order_read_models" ADD CONSTRAINT "warehouse_order_read_models_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_outbox" ADD CONSTRAINT "warehouse_outbox_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_outbox" ADD CONSTRAINT "warehouse_outbox_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_projection_inbox" ADD CONSTRAINT "warehouse_projection_inbox_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_projection_inbox" ADD CONSTRAINT "warehouse_projection_inbox_warehouse_site_id_fkey" FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
