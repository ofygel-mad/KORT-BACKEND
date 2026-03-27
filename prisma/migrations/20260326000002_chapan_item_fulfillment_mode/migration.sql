ALTER TABLE "chapan_order_items"
ADD COLUMN "fulfillment_mode" TEXT NOT NULL DEFAULT 'unassigned';

UPDATE "chapan_order_items" AS item
SET "fulfillment_mode" = 'production'
WHERE EXISTS (
  SELECT 1
  FROM "chapan_production_tasks" AS task
  WHERE task."order_item_id" = item."id"
);

UPDATE "chapan_order_items" AS item
SET "fulfillment_mode" = 'warehouse'
WHERE item."fulfillment_mode" = 'unassigned'
  AND EXISTS (
    SELECT 1
    FROM "chapan_orders" AS ord
    WHERE ord."id" = item."order_id"
      AND ord."status" IN ('ready', 'on_warehouse', 'shipped', 'completed')
  );
