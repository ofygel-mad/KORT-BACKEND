-- WarehouseFieldDefinition
CREATE TABLE "warehouse_field_definitions" (
  "id"                    TEXT NOT NULL,
  "org_id"                TEXT NOT NULL,
  "code"                  TEXT NOT NULL,
  "label"                 TEXT NOT NULL,
  "entity_scope"          TEXT NOT NULL DEFAULT 'both',
  "input_type"            TEXT NOT NULL,
  "is_required"           BOOLEAN NOT NULL DEFAULT false,
  "is_variant_axis"       BOOLEAN NOT NULL DEFAULT false,
  "show_in_warehouse_form" BOOLEAN NOT NULL DEFAULT true,
  "show_in_order_form"    BOOLEAN NOT NULL DEFAULT true,
  "show_in_documents"     BOOLEAN NOT NULL DEFAULT true,
  "affects_availability"  BOOLEAN NOT NULL DEFAULT true,
  "sort_order"            INTEGER NOT NULL DEFAULT 0,
  "is_system"             BOOLEAN NOT NULL DEFAULT false,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_field_definitions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warehouse_field_definitions_org_id_code_key" ON "warehouse_field_definitions"("org_id", "code");
CREATE INDEX "warehouse_field_definitions_org_id_sort_order_idx" ON "warehouse_field_definitions"("org_id", "sort_order");
ALTER TABLE "warehouse_field_definitions" ADD CONSTRAINT "warehouse_field_definitions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WarehouseFieldOption
CREATE TABLE "warehouse_field_options" (
  "id"            TEXT NOT NULL,
  "definition_id" TEXT NOT NULL,
  "value"         TEXT NOT NULL,
  "label"         TEXT NOT NULL,
  "sort_order"    INTEGER NOT NULL DEFAULT 0,
  "color_hex"     TEXT,
  "is_active"     BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "warehouse_field_options_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warehouse_field_options_definition_id_value_key" ON "warehouse_field_options"("definition_id", "value");
CREATE INDEX "warehouse_field_options_definition_id_sort_order_idx" ON "warehouse_field_options"("definition_id", "sort_order");
ALTER TABLE "warehouse_field_options" ADD CONSTRAINT "warehouse_field_options_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "warehouse_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WarehouseProductCatalog
CREATE TABLE "warehouse_product_catalog" (
  "id"              TEXT NOT NULL,
  "org_id"          TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "is_active"       BOOLEAN NOT NULL DEFAULT true,
  "source"          TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_product_catalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warehouse_product_catalog_org_id_normalized_name_key" ON "warehouse_product_catalog"("org_id", "normalized_name");
CREATE INDEX "warehouse_product_catalog_org_id_idx" ON "warehouse_product_catalog"("org_id");
ALTER TABLE "warehouse_product_catalog" ADD CONSTRAINT "warehouse_product_catalog_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WarehouseProductField
CREATE TABLE "warehouse_product_fields" (
  "id"            TEXT NOT NULL,
  "product_id"    TEXT NOT NULL,
  "definition_id" TEXT NOT NULL,
  "is_required"   BOOLEAN NOT NULL DEFAULT false,
  "sort_order"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "warehouse_product_fields_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "warehouse_product_fields_product_id_definition_id_key" ON "warehouse_product_fields"("product_id", "definition_id");
ALTER TABLE "warehouse_product_fields" ADD CONSTRAINT "warehouse_product_fields_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "warehouse_product_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "warehouse_product_fields" ADD CONSTRAINT "warehouse_product_fields_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "warehouse_field_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Extend WarehouseItem
ALTER TABLE "warehouse_items"
  ADD COLUMN "product_catalog_id" TEXT,
  ADD COLUMN "variant_key"        TEXT,
  ADD COLUMN "attributes_json"    JSONB,
  ADD COLUMN "attributes_summary" TEXT;
CREATE INDEX "warehouse_items_org_id_variant_key_idx" ON "warehouse_items"("org_id", "variant_key");
ALTER TABLE "warehouse_items" ADD CONSTRAINT "warehouse_items_product_catalog_id_fkey" FOREIGN KEY ("product_catalog_id") REFERENCES "warehouse_product_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Extend ChapanOrderItem
ALTER TABLE "chapan_order_items"
  ADD COLUMN "variant_key"        TEXT,
  ADD COLUMN "attributes_json"    JSONB,
  ADD COLUMN "attributes_summary" TEXT;
