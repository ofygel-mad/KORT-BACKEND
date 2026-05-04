-- CreateTable: WarehouseTransitZone
CREATE TABLE "warehouse_transit_zones" (
    "id"         TEXT NOT NULL,
    "org_id"     TEXT NOT NULL,
    "name"       TEXT NOT NULL DEFAULT 'Транзит',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_transit_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WarehouseTransitEntry
CREATE TABLE "warehouse_transit_entries" (
    "id"          TEXT NOT NULL,
    "org_id"      TEXT NOT NULL,
    "zone_id"     TEXT NOT NULL,
    "item_id"     TEXT NOT NULL,
    "order_id"    TEXT,
    "qty"         DOUBLE PRECISION NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'in_transit',
    "source_type" TEXT NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_transit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_transit_zones_org_id_idx" ON "warehouse_transit_zones"("org_id");

-- CreateIndex
CREATE INDEX "warehouse_transit_entries_org_id_status_idx" ON "warehouse_transit_entries"("org_id", "status");

-- CreateIndex
CREATE INDEX "warehouse_transit_entries_order_id_idx" ON "warehouse_transit_entries"("order_id");

-- AddForeignKey
ALTER TABLE "warehouse_transit_zones"
    ADD CONSTRAINT "warehouse_transit_zones_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_transit_entries"
    ADD CONSTRAINT "warehouse_transit_entries_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_transit_entries"
    ADD CONSTRAINT "warehouse_transit_entries_zone_id_fkey"
    FOREIGN KEY ("zone_id") REFERENCES "warehouse_transit_zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_transit_entries"
    ADD CONSTRAINT "warehouse_transit_entries_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "warehouse_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
