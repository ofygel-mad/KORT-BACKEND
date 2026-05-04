ALTER TABLE "warehouse_layout_versions"
  ADD COLUMN "validation_status" TEXT NOT NULL DEFAULT 'not_validated',
  ADD COLUMN "validation_summary_json" JSONB,
  ADD COLUMN "validated_at" TIMESTAMP(3);

ALTER TABLE "warehouse_tasks"
  ADD COLUMN "assignee_name" TEXT,
  ADD COLUMN "assignee_role" TEXT,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "sla_status" TEXT NOT NULL DEFAULT 'on_track';

ALTER TABLE "warehouse_exceptions"
  ADD COLUMN "owner_name" TEXT,
  ADD COLUMN "owner_role" TEXT,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "due_at" TIMESTAMP(3),
  ADD COLUMN "resolution_code" TEXT,
  ADD COLUMN "sla_status" TEXT NOT NULL DEFAULT 'on_track';

CREATE INDEX "warehouse_tasks_org_id_warehouse_site_id_sla_status_idx"
  ON "warehouse_tasks"("org_id", "warehouse_site_id", "sla_status");

CREATE INDEX "warehouse_exceptions_org_id_warehouse_site_id_sla_status_idx"
  ON "warehouse_exceptions"("org_id", "warehouse_site_id", "sla_status");

CREATE INDEX "warehouse_layout_versions_org_id_warehouse_site_id_validation_status_idx"
  ON "warehouse_layout_versions"("org_id", "warehouse_site_id", "validation_status");
