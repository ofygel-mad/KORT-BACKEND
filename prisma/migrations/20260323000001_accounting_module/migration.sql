-- Accounting Module Migration

CREATE TABLE "accounting_entries" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "category" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "counterparty" TEXT,
    "source_module" TEXT,
    "source_id" TEXT,
    "source_label" TEXT,
    "period" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "is_reconciled" BOOLEAN NOT NULL DEFAULT false,
    "reconciled_at" TIMESTAMP(3),
    "reconciled_by" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounting_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "accounting_gaps" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "description" TEXT NOT NULL,
    "source_module" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "accounting_gaps_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "import_templates" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "header_row_index" INTEGER NOT NULL DEFAULT 0,
    "data_start_row" INTEGER NOT NULL DEFAULT 1,
    "sheet_name" TEXT,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_templates_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "accounting_entries_hash_key" ON "accounting_entries"("hash");
CREATE UNIQUE INDEX "accounting_entries_org_id_seq_key" ON "accounting_entries"("org_id", "seq");
CREATE UNIQUE INDEX "accounting_gaps_org_id_source_module_source_id_type_key" ON "accounting_gaps"("org_id", "source_module", "source_id", "type");
CREATE UNIQUE INDEX "import_templates_org_id_name_key" ON "import_templates"("org_id", "name");

-- Indexes
CREATE INDEX "accounting_entries_org_id_period_idx" ON "accounting_entries"("org_id", "period");
CREATE INDEX "accounting_entries_org_id_type_idx" ON "accounting_entries"("org_id", "type");
CREATE INDEX "accounting_entries_org_id_source_module_source_id_idx" ON "accounting_entries"("org_id", "source_module", "source_id");
CREATE INDEX "accounting_gaps_org_id_status_idx" ON "accounting_gaps"("org_id", "status");
CREATE INDEX "import_templates_org_id_idx" ON "import_templates"("org_id");

-- Foreign keys
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "accounting_gaps" ADD CONSTRAINT "accounting_gaps_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_templates" ADD CONSTRAINT "import_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
