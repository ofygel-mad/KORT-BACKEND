-- Migration: Fix WarehouseItem variantKey format
-- Issue: variantKey was stored in incorrect format (name:key=value) instead of (name|key:value)
-- This causes items imported via bulk import to not be found when orders query them
--
-- Before:  рубашка:цвет=синий:размер=44
-- After:   рубашка|цвет:синий|размер:44

-- Helper function to normalize name (same as normalizeWarehouseName in code)
CREATE OR REPLACE FUNCTION normalize_warehouse_name(value TEXT) RETURNS TEXT AS $$
BEGIN
  RETURN LOWER(TRIM(REGEXP_REPLACE(value, '\s+', ' ', 'g')));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper function to build correct variantKey
-- Takes JSON object of attributes and builds: base|key:value|key:value
CREATE OR REPLACE FUNCTION build_variant_key_correct(
  p_product_name TEXT,
  p_attributes_json JSONB
) RETURNS TEXT AS $$
DECLARE
  v_base TEXT;
  v_parts TEXT[];
  v_key TEXT;
  v_value TEXT;
BEGIN
  v_base := normalize_warehouse_name(p_product_name);
  v_parts := ARRAY[v_base];

  -- Build parts from attributes sorted by key
  FOR v_key, v_value IN
    SELECT k, normalize_warehouse_name(val::TEXT)
    FROM jsonb_each_text(COALESCE(p_attributes_json, '{}'::JSONB))
    WHERE TRIM(val::TEXT) != ''
    ORDER BY k
  LOOP
    v_parts := array_append(v_parts, v_key || ':' || v_value);
  END LOOP;

  RETURN array_to_string(v_parts, '|');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Update all WarehouseItem records with incorrect variantKey format
UPDATE warehouse_item
SET variant_key = build_variant_key_correct(name, attributes_json)
WHERE org_id IS NOT NULL
  AND variant_key LIKE '%=%' -- Old format contains '='
  AND variant_key NOT LIKE '%|%'; -- And doesn't contain '|'

-- Verify: Check if there are any old format keys left
-- SELECT COUNT(*) as old_format_count
-- FROM warehouse_item
-- WHERE variant_key LIKE '%=%' AND variant_key NOT LIKE '%|%';

-- Clean up
DROP FUNCTION IF EXISTS build_variant_key_correct(TEXT, JSONB);
DROP FUNCTION IF EXISTS normalize_warehouse_name(TEXT);
