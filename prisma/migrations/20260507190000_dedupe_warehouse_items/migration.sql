-- Consolidate duplicate WarehouseItem rows that share the same (org_id, variant_key).
--
-- Background: legacy receipt flows historically inserted a new row per batch
-- instead of accumulating into an existing row. After the canonical-key migration
-- (20260507180000) those rows now collapse onto the same key. Two rows for the
-- same SKU caused the order form to non-deterministically read "qty=0, reserved=1"
-- vs "qty=5, reserved=0" and show "Нет на складе" even when stock existed.
--
-- This migration:
--   1. Picks the earliest-created row per (org_id, variant_key) as the survivor.
--   2. Re-points every dependent row (movements, reservations, lots, alerts,
--      BOM lines, transit entries) at the survivor.
--   3. Sums the duplicates' qty / qty_reserved / qty_beginning into the survivor.
--   4. Deletes the duplicates. Their FK rows have already been moved, so CASCADE
--      no longer destroys real history.
--
-- Idempotent: re-running the migration is a no-op once duplicates are gone
-- (the temp table will be empty).

-- 1. Build the survivor map for every duplicate group.
CREATE TEMP TABLE warehouse_item_dedupe_map ON COMMIT DROP AS
SELECT
  ranked.id          AS duplicate_id,
  survivors.id       AS survivor_id
FROM (
  SELECT
    id,
    org_id,
    variant_key,
    qty,
    qty_reserved,
    qty_beginning,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, variant_key
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM warehouse_items
  WHERE variant_key IS NOT NULL
) ranked
JOIN (
  SELECT
    id,
    org_id,
    variant_key
  FROM (
    SELECT
      id,
      org_id,
      variant_key,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, variant_key
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM warehouse_items
    WHERE variant_key IS NOT NULL
  ) s
  WHERE s.rn = 1
) survivors
  ON survivors.org_id = ranked.org_id
 AND survivors.variant_key = ranked.variant_key
WHERE ranked.rn > 1;

-- 2. Re-point dependent rows. Each table's FK is item_id with ON DELETE CASCADE,
--    so we must move the children BEFORE deleting the duplicate item.
UPDATE warehouse_movements    m SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE m.item_id = d.duplicate_id;
UPDATE warehouse_reservations r SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE r.item_id = d.duplicate_id;
UPDATE warehouse_lots         l SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE l.item_id = d.duplicate_id;
UPDATE warehouse_alerts       a SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE a.item_id = d.duplicate_id;
UPDATE warehouse_bom_lines    b SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE b.item_id = d.duplicate_id;
UPDATE warehouse_transit_entries t SET item_id = d.survivor_id FROM warehouse_item_dedupe_map d WHERE t.item_id = d.duplicate_id;

-- 3. Sum the duplicates' quantities into the survivor.
UPDATE warehouse_items s
SET
  qty           = s.qty           + agg.sum_qty,
  qty_reserved  = s.qty_reserved  + agg.sum_reserved,
  qty_beginning = s.qty_beginning + agg.sum_beginning,
  updated_at    = NOW()
FROM (
  SELECT
    d.survivor_id,
    SUM(it.qty)           AS sum_qty,
    SUM(it.qty_reserved)  AS sum_reserved,
    SUM(it.qty_beginning) AS sum_beginning
  FROM warehouse_item_dedupe_map d
  JOIN warehouse_items it ON it.id = d.duplicate_id
  GROUP BY d.survivor_id
) agg
WHERE s.id = agg.survivor_id;

-- 4. Delete the duplicates. Their FK children have already been re-pointed.
DELETE FROM warehouse_items WHERE id IN (SELECT duplicate_id FROM warehouse_item_dedupe_map);

-- 5. Add a unique index on (org_id, variant_key) so application code can never
--    re-introduce duplicates. Existing index `warehouse_items_org_id_variant_key_idx`
--    is non-unique; we add the constraint alongside it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'warehouse_items_org_variant_key_unique'
  ) THEN
    CREATE UNIQUE INDEX warehouse_items_org_variant_key_unique
      ON warehouse_items (org_id, variant_key)
      WHERE variant_key IS NOT NULL;
  END IF;
END $$;
