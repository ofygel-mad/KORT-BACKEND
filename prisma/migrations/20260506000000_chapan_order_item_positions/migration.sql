-- Backfill and enforce per-card item positions for Chapan order items.

ALTER TABLE "chapan_order_items"
ADD COLUMN "item_position" INTEGER;

UPDATE "chapan_order_items" AS coi
SET "item_position" = ranked.rn
FROM (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "order_id"
      ORDER BY id
    ) AS rn
  FROM "chapan_order_items"
) AS ranked
WHERE ranked.id = coi.id;

ALTER TABLE "chapan_order_items"
ALTER COLUMN "item_position" SET NOT NULL;

ALTER TABLE "chapan_order_items"
ADD CONSTRAINT "chapan_order_items_order_id_item_position_key"
UNIQUE ("order_id", "item_position");

CREATE INDEX "chapan_order_items_order_id_item_position_idx"
ON "chapan_order_items" ("order_id", "item_position");
