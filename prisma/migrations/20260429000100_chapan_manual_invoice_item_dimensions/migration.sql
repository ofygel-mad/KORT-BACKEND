ALTER TABLE "chapan_manual_invoice_items"
  ADD COLUMN IF NOT EXISTS "gender" TEXT,
  ADD COLUMN IF NOT EXISTS "length" TEXT;
