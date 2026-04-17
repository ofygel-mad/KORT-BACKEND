-- AddWarehouseAccumulationMethod
-- Adds qtyBeginning and verificationRequired to warehouse_items for the Accumulation Method

ALTER TABLE "warehouse_items"
  ADD COLUMN "qty_beginning" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "verification_required" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing items with positive qty are treated as already-verified opening balance
UPDATE "warehouse_items" SET "qty_beginning" = "qty" WHERE "qty" > 0;

CREATE INDEX "warehouse_items_org_verification_idx"
  ON "warehouse_items" ("org_id", "verification_required");
