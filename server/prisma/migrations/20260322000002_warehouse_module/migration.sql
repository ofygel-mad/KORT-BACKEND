-- Warehouse Module Migration

CREATE TABLE "warehouse_categories" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#888888',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_categories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_locations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_items" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "category_id" TEXT,
    "location_id" TEXT,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'шт',
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_reserved" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_min" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "qty_max" DOUBLE PRECISION,
    "cost_price" DOUBLE PRECISION,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "qr_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "warehouse_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_movements" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "qty_before" DOUBLE PRECISION NOT NULL,
    "qty_after" DOUBLE PRECISION NOT NULL,
    "source_id" TEXT,
    "source_type" TEXT,
    "lot_id" TEXT,
    "reason" TEXT,
    "author" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_reservations" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "warehouse_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_bom_lines" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "product_key" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "qty_per_unit" DOUBLE PRECISION NOT NULL,
    CONSTRAINT "warehouse_bom_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_alerts" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source_id" TEXT,
    "qty_need" DOUBLE PRECISION,
    "qty_have" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    CONSTRAINT "warehouse_alerts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_lots" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "lot_number" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "supplier" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "notes" TEXT,
    CONSTRAINT "warehouse_lots_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "warehouse_categories_org_id_name_key" ON "warehouse_categories"("org_id", "name");
CREATE UNIQUE INDEX "warehouse_locations_org_id_name_key" ON "warehouse_locations"("org_id", "name");
CREATE UNIQUE INDEX "warehouse_items_qr_code_key" ON "warehouse_items"("qr_code");
CREATE UNIQUE INDEX "warehouse_bom_lines_org_id_product_key_item_id_key" ON "warehouse_bom_lines"("org_id", "product_key", "item_id");

-- Indexes
CREATE INDEX "warehouse_categories_org_id_idx" ON "warehouse_categories"("org_id");
CREATE INDEX "warehouse_items_org_id_idx" ON "warehouse_items"("org_id");
CREATE INDEX "warehouse_items_org_id_category_id_idx" ON "warehouse_items"("org_id", "category_id");
CREATE INDEX "warehouse_movements_org_id_created_at_idx" ON "warehouse_movements"("org_id", "created_at");
CREATE INDEX "warehouse_movements_item_id_idx" ON "warehouse_movements"("item_id");
CREATE INDEX "warehouse_reservations_org_id_status_idx" ON "warehouse_reservations"("org_id", "status");
CREATE INDEX "warehouse_reservations_source_id_idx" ON "warehouse_reservations"("source_id");
CREATE INDEX "warehouse_bom_lines_org_id_product_key_idx" ON "warehouse_bom_lines"("org_id", "product_key");
CREATE INDEX "warehouse_alerts_org_id_status_idx" ON "warehouse_alerts"("org_id", "status");
CREATE INDEX "warehouse_alerts_item_id_idx" ON "warehouse_alerts"("item_id");
CREATE INDEX "warehouse_lots_org_id_item_id_idx" ON "warehouse_lots"("org_id", "item_id");
CREATE INDEX "warehouse_locations_org_id_idx" ON "warehouse_locations"("org_id");

-- Foreign keys
ALTER TABLE "warehouse_categories" ADD CONSTRAINT "warehouse_categories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_items" ADD CONSTRAINT "warehouse_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_items" ADD CONSTRAINT "warehouse_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "warehouse_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_items" ADD CONSTRAINT "warehouse_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_movements" ADD CONSTRAINT "warehouse_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_reservations" ADD CONSTRAINT "warehouse_reservations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_reservations" ADD CONSTRAINT "warehouse_reservations_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_bom_lines" ADD CONSTRAINT "warehouse_bom_lines_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_bom_lines" ADD CONSTRAINT "warehouse_bom_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_alerts" ADD CONSTRAINT "warehouse_alerts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_alerts" ADD CONSTRAINT "warehouse_alerts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_lots" ADD CONSTRAINT "warehouse_lots_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_lots" ADD CONSTRAINT "warehouse_lots_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
