ALTER TABLE "chapan_manual_invoices"
ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE INDEX "chapan_manual_invoices_org_id_archived_at_idx"
ON "chapan_manual_invoices"("org_id", "archived_at");
