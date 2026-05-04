-- CreateTable chapan_manual_invoices
CREATE TABLE IF NOT EXISTS "chapan_manual_invoices" (
    "id"              TEXT NOT NULL,
    "org_id"          TEXT NOT NULL,
    "type"            TEXT NOT NULL,
    "invoice_num"     TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "notes"           TEXT,
    "created_by_id"   TEXT NOT NULL,
    "created_by_name" TEXT NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapan_manual_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable chapan_manual_invoice_items
CREATE TABLE IF NOT EXISTS "chapan_manual_invoice_items" (
    "id"           TEXT NOT NULL,
    "invoice_id"   TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "color"        TEXT,
    "size"         TEXT,
    "quantity"     INTEGER NOT NULL DEFAULT 1,
    "unit_price"   DOUBLE PRECISION NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapan_manual_invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chapan_manual_invoices_org_id_type_idx"
    ON "chapan_manual_invoices"("org_id", "type");

CREATE INDEX IF NOT EXISTS "chapan_manual_invoices_org_id_created_at_idx"
    ON "chapan_manual_invoices"("org_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "chapan_manual_invoices_org_id_invoice_num_key"
    ON "chapan_manual_invoices"("org_id", "invoice_num");

CREATE INDEX IF NOT EXISTS "chapan_manual_invoice_items_invoice_id_idx"
    ON "chapan_manual_invoice_items"("invoice_id");

-- AddForeignKey
ALTER TABLE "chapan_manual_invoices"
    ADD CONSTRAINT "chapan_manual_invoices_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chapan_manual_invoice_items"
    ADD CONSTRAINT "chapan_manual_invoice_items_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "chapan_manual_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
