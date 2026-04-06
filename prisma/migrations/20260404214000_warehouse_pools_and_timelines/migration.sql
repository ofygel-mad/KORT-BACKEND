ALTER TABLE "warehouse_tasks"
  ADD COLUMN "assignee_pool_id" TEXT,
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_id" TEXT,
  ADD COLUMN "source_line_id" TEXT;

ALTER TABLE "warehouse_exceptions"
  ADD COLUMN "owner_pool_id" TEXT,
  ADD COLUMN "source_type" TEXT,
  ADD COLUMN "source_id" TEXT;

CREATE TABLE "warehouse_assignee_pools" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "warehouse_site_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "pool_type" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "capacity_limit" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "warehouse_assignee_pools_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_task_events" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "warehouse_site_id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "actor_name" TEXT,
  "payload_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_task_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "warehouse_exception_events" (
  "id" TEXT NOT NULL,
  "org_id" TEXT NOT NULL,
  "warehouse_site_id" TEXT NOT NULL,
  "exception_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "actor_name" TEXT,
  "payload_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "warehouse_exception_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "warehouse_assignee_pools_warehouse_site_id_code_key"
  ON "warehouse_assignee_pools"("warehouse_site_id", "code");
CREATE INDEX "warehouse_assignee_pools_org_id_warehouse_site_id_pool_type_a_idx"
  ON "warehouse_assignee_pools"("org_id", "warehouse_site_id", "pool_type", "active");
CREATE INDEX "warehouse_task_events_org_id_warehouse_site_id_created_at_idx"
  ON "warehouse_task_events"("org_id", "warehouse_site_id", "created_at");
CREATE INDEX "warehouse_task_events_task_id_created_at_idx"
  ON "warehouse_task_events"("task_id", "created_at");
CREATE INDEX "warehouse_exception_events_org_id_warehouse_site_id_created__idx"
  ON "warehouse_exception_events"("org_id", "warehouse_site_id", "created_at");
CREATE INDEX "warehouse_exception_events_exception_id_created_at_idx"
  ON "warehouse_exception_events"("exception_id", "created_at");

CREATE INDEX "warehouse_tasks_assignee_pool_id_idx"
  ON "warehouse_tasks"("assignee_pool_id");
CREATE INDEX "warehouse_exceptions_owner_pool_id_idx"
  ON "warehouse_exceptions"("owner_pool_id");

ALTER TABLE "warehouse_tasks"
  ADD CONSTRAINT "warehouse_tasks_assignee_pool_id_fkey"
  FOREIGN KEY ("assignee_pool_id") REFERENCES "warehouse_assignee_pools"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_exceptions"
  ADD CONSTRAINT "warehouse_exceptions_owner_pool_id_fkey"
  FOREIGN KEY ("owner_pool_id") REFERENCES "warehouse_assignee_pools"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "warehouse_assignee_pools"
  ADD CONSTRAINT "warehouse_assignee_pools_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_assignee_pools"
  ADD CONSTRAINT "warehouse_assignee_pools_warehouse_site_id_fkey"
  FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_task_events"
  ADD CONSTRAINT "warehouse_task_events_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_task_events"
  ADD CONSTRAINT "warehouse_task_events_warehouse_site_id_fkey"
  FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_task_events"
  ADD CONSTRAINT "warehouse_task_events_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "warehouse_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_exception_events"
  ADD CONSTRAINT "warehouse_exception_events_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_exception_events"
  ADD CONSTRAINT "warehouse_exception_events_warehouse_site_id_fkey"
  FOREIGN KEY ("warehouse_site_id") REFERENCES "warehouse_sites"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "warehouse_exception_events"
  ADD CONSTRAINT "warehouse_exception_events_exception_id_fkey"
  FOREIGN KEY ("exception_id") REFERENCES "warehouse_exceptions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
