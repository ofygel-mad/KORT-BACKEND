CREATE TABLE "warehouse_tasks" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "bin_id" TEXT,
    "source_bin_id" TEXT,
    "target_bin_id" TEXT,
    "variant_id" TEXT,
    "reservation_id" TEXT,
    "task_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source_strategy" TEXT,
    "external_key" TEXT NOT NULL,
    "route_key" TEXT,
    "metadata_json" JSONB,
    "due_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_exceptions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "bin_id" TEXT,
    "task_id" TEXT,
    "variant_id" TEXT,
    "exception_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source_strategy" TEXT,
    "external_key" TEXT NOT NULL,
    "metadata_json" JSONB,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_exceptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_layout_nodes" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "warehouse_site_id" TEXT NOT NULL,
    "layout_version_id" TEXT NOT NULL,
    "zone_id" TEXT,
    "bin_id" TEXT,
    "parent_node_id" TEXT,
    "node_type" TEXT NOT NULL,
    "domain_type" TEXT NOT NULL,
    "domain_id" TEXT NOT NULL,
    "label" TEXT,
    "x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "width" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "height" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "rotation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "z_index" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "metadata_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_layout_nodes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_tasks_org_id_warehouse_site_id_external_key_key"
ON "warehouse_tasks"("org_id", "warehouse_site_id", "external_key");

CREATE INDEX "warehouse_tasks_org_id_warehouse_site_id_status_task_type_idx"
ON "warehouse_tasks"("org_id", "warehouse_site_id", "status", "task_type");

CREATE INDEX "warehouse_tasks_zone_id_idx" ON "warehouse_tasks"("zone_id");
CREATE INDEX "warehouse_tasks_bin_id_idx" ON "warehouse_tasks"("bin_id");
CREATE INDEX "warehouse_tasks_source_bin_id_idx" ON "warehouse_tasks"("source_bin_id");
CREATE INDEX "warehouse_tasks_target_bin_id_idx" ON "warehouse_tasks"("target_bin_id");

CREATE UNIQUE INDEX "warehouse_exceptions_org_id_warehouse_site_id_external_key_key"
ON "warehouse_exceptions"("org_id", "warehouse_site_id", "external_key");

CREATE INDEX "warehouse_exceptions_org_id_warehouse_site_id_status_severity_idx"
ON "warehouse_exceptions"("org_id", "warehouse_site_id", "status", "severity");

CREATE INDEX "warehouse_exceptions_zone_id_idx" ON "warehouse_exceptions"("zone_id");
CREATE INDEX "warehouse_exceptions_bin_id_idx" ON "warehouse_exceptions"("bin_id");
CREATE INDEX "warehouse_exceptions_task_id_idx" ON "warehouse_exceptions"("task_id");

CREATE UNIQUE INDEX "warehouse_layout_nodes_layout_version_id_domain_type_domain_id_key"
ON "warehouse_layout_nodes"("layout_version_id", "domain_type", "domain_id");

CREATE INDEX "warehouse_layout_nodes_org_id_warehouse_site_id_layout_version_id_idx"
ON "warehouse_layout_nodes"("org_id", "warehouse_site_id", "layout_version_id");

CREATE INDEX "warehouse_layout_nodes_zone_id_idx" ON "warehouse_layout_nodes"("zone_id");
CREATE INDEX "warehouse_layout_nodes_bin_id_idx" ON "warehouse_layout_nodes"("bin_id");
CREATE INDEX "warehouse_layout_nodes_parent_node_id_idx" ON "warehouse_layout_nodes"("parent_node_id");

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_warehouse_site_id_fkey"
FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_zone_id_fkey"
FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_bin_id_fkey"
FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_source_bin_id_fkey"
FOREIGN KEY ("source_bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_target_bin_id_fkey"
FOREIGN KEY ("target_bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_variant_id_fkey"
FOREIGN KEY ("variant_id") REFERENCES "warehouse_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_tasks"
ADD CONSTRAINT "warehouse_tasks_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "warehouse_stock_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_warehouse_site_id_fkey"
FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_zone_id_fkey"
FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_bin_id_fkey"
FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_task_id_fkey"
FOREIGN KEY ("task_id") REFERENCES "warehouse_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
ADD CONSTRAINT "warehouse_exceptions_variant_id_fkey"
FOREIGN KEY ("variant_id") REFERENCES "warehouse_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_warehouse_site_id_fkey"
FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_layout_version_id_fkey"
FOREIGN KEY ("layout_version_id") REFERENCES "warehouse_layout_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_zone_id_fkey"
FOREIGN KEY ("zone_id") REFERENCES "warehouse_zones"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_bin_id_fkey"
FOREIGN KEY ("bin_id") REFERENCES "warehouse_bins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_layout_nodes"
ADD CONSTRAINT "warehouse_layout_nodes_parent_node_id_fkey"
FOREIGN KEY ("parent_node_id") REFERENCES "warehouse_layout_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
