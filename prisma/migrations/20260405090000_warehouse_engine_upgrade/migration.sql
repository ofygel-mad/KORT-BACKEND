-- Execution engine upgrade: assignment policies, SLA escalation, layout publish audit

-- Assignment policy and escalation fields on pools
ALTER TABLE "warehouse_assignee_pools"
  ADD COLUMN "assignment_policy" TEXT NOT NULL DEFAULT 'fifo',
  ADD COLUMN "sla_timeout_min" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "escalation_pool_id" TEXT;

ALTER TABLE "warehouse_assignee_pools"
  ADD CONSTRAINT "warehouse_assignee_pools_escalation_pool_id_fkey"
  FOREIGN KEY ("escalation_pool_id") REFERENCES "warehouse_assignee_pools"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Escalation tracking on tasks
ALTER TABLE "warehouse_tasks"
  ADD COLUMN "escalation_level" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "escalated_at" TIMESTAMP(3);

CREATE INDEX "warehouse_tasks_org_id_warehouse_site_id_sla_status_escalation_idx"
  ON "warehouse_tasks"("org_id", "warehouse_site_id", "sla_status", "escalation_level");

-- Layout publish audit log
CREATE TABLE "warehouse_layout_publish_audit" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "warehouse_site_id" TEXT NOT NULL,
  "layout_version_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actor_name" TEXT NOT NULL,
  "force_reason" TEXT,
  "previous_version_id" TEXT,
  "blocker_summary_json" JSONB,
  "impacted_task_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_layout_publish_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "warehouse_layout_publish_audit_org_id_site_id_created_at_idx"
  ON "warehouse_layout_publish_audit"("org_id", "warehouse_site_id", "created_at" DESC);

CREATE INDEX "warehouse_layout_publish_audit_layout_version_id_idx"
  ON "warehouse_layout_publish_audit"("layout_version_id");

ALTER TABLE "warehouse_layout_publish_audit"
  ADD CONSTRAINT "warehouse_layout_publish_audit_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_publish_audit"
  ADD CONSTRAINT "warehouse_layout_publish_audit_warehouse_site_id_fkey"
  FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
