-- Remove fabric/Ткань from all chapan tables and drop the fabric catalog table

ALTER TABLE "chapan_order_items" DROP COLUMN IF EXISTS "fabric";
ALTER TABLE "chapan_production_tasks" DROP COLUMN IF EXISTS "fabric";
ALTER TABLE "chapan_return_items" DROP COLUMN IF EXISTS "fabric";
ALTER TABLE "chapan_request_items" DROP COLUMN IF EXISTS "fabric_preference";
DROP TABLE IF EXISTS "chapan_catalog_fabrics";
