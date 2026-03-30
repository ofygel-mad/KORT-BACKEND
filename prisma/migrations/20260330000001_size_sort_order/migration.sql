-- AlterTable: add sort_order to chapan_catalog_sizes
ALTER TABLE "chapan_catalog_sizes" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "chapan_catalog_sizes_org_id_sort_order_idx" ON "chapan_catalog_sizes"("org_id", "sort_order");

-- BackfillData: numeric sort for existing sizes
-- Numbers sort numerically, letters sort alphabetically after numbers
UPDATE "chapan_catalog_sizes"
SET "sort_order" = CASE
  WHEN name ~ '^[0-9]+$' THEN CAST(name AS INTEGER)
  WHEN name IN ('XS','xs') THEN 142
  WHEN name IN ('S','s')   THEN 144
  WHEN name IN ('M','m')   THEN 146
  WHEN name IN ('L','l')   THEN 148
  WHEN name IN ('XL','xl') THEN 150
  WHEN name IN ('XXL','xxl','2XL','2xl') THEN 152
  WHEN name IN ('XXXL','xxxl','3XL','3xl') THEN 154
  ELSE 999
END;
