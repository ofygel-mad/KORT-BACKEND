CREATE TABLE "warehouse_site_read_models" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "warehouse_site_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'fresh',
  "last_event_id" TEXT,
  "last_event_type" TEXT,
  "refreshed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "warehouse_site_read_models_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_site_read_models_org_id_warehouse_site_id_key"
  ON "warehouse_site_read_models"("org_id", "warehouse_site_id");

CREATE INDEX "warehouse_site_read_models_org_id_refreshed_at_idx"
  ON "warehouse_site_read_models"("org_id", "refreshed_at");

ALTER TABLE "warehouse_site_read_models"
  ADD CONSTRAINT "warehouse_site_read_models_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_site_read_models"
  ADD CONSTRAINT "warehouse_site_read_models_warehouse_site_id_fkey"
  FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
