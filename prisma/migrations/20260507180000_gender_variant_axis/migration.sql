-- Make `gender` a real variant axis: warehouse SKUs and order lookups must
-- distinguish мужской vs женский. Before this migration gender was stored on
-- both items and orders but excluded from variantKey, so the order form
-- couldn't tell apart two physically different SKUs.
--
-- Steps:
--   1. Define a temporary PL/pgSQL helper that builds the canonical variantKey
--      identical to server/src/shared/variant-key.ts (lowercase + collapse
--      whitespace, sort by code, drop empty values, drop axes whose definition
--      has affects_availability=false).
--   2. Flip gender field definitions to affects_availability=true.
--   3. Recompute variantKey for every WarehouseVariant and WarehouseItem so
--      they line up with the new keying rule.
--   4. Drop the helper.
--
-- Idempotency: re-running this migration is safe because the recompute always
-- yields the same key for the same (name, attributes, field defs).

CREATE OR REPLACE FUNCTION pg_temp.normalize_variant_value(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL THEN RETURN ''; END IF;
  RETURN regexp_replace(btrim(lower(value)), '\s+', ' ', 'g');
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.build_canonical_variant_key(
  p_org_id TEXT,
  p_product_name TEXT,
  p_attributes JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_base TEXT;
  v_parts TEXT[];
  v_pair RECORD;
BEGIN
  v_base := pg_temp.normalize_variant_value(p_product_name);

  IF p_attributes IS NULL OR jsonb_typeof(p_attributes) <> 'object' THEN
    RETURN v_base;
  END IF;

  -- Pull every (code, value) pair from attributesJson where:
  --   * the field definition for that code on this org has affects_availability=true
  --   * the value is not null and not empty after trimming
  -- Sort by code so the resulting key is order-independent.
  SELECT array_agg(
           kv.code || ':' || pg_temp.normalize_variant_value(kv.raw)
           ORDER BY kv.code
         )
    INTO v_parts
  FROM (
    SELECT
      attr.key   AS code,
      attr.value AS raw
    FROM jsonb_each_text(p_attributes) AS attr(key, value)
    JOIN warehouse_field_definitions def
      ON def.org_id = p_org_id
     AND def.code = attr.key
     AND def.affects_availability = TRUE
    WHERE attr.value IS NOT NULL
      AND btrim(attr.value) <> ''
  ) kv;

  IF v_parts IS NULL OR array_length(v_parts, 1) IS NULL THEN
    RETURN v_base;
  END IF;

  RETURN v_base || '|' || array_to_string(v_parts, '|');
END;
$$;

-- Step 2: flip gender field definitions
UPDATE warehouse_field_definitions
SET affects_availability = TRUE,
    is_variant_axis = TRUE,
    updated_at = NOW()
WHERE code = 'gender';

-- Step 3a: recompute variantKey for canonical variants
UPDATE warehouse_variants v
SET variant_key = pg_temp.build_canonical_variant_key(
      v.org_id,
      cat.name,
      COALESCE(v.attributes_json, '{}'::jsonb)
    ),
    updated_at = NOW()
FROM warehouse_product_catalog cat
WHERE cat.id = v.product_catalog_id
  AND v.variant_key IS DISTINCT FROM pg_temp.build_canonical_variant_key(
        v.org_id,
        cat.name,
        COALESCE(v.attributes_json, '{}'::jsonb)
      );

-- Step 3b: recompute variantKey for legacy warehouse_items
UPDATE warehouse_items it
SET variant_key = pg_temp.build_canonical_variant_key(
      it.org_id,
      it.name,
      COALESCE(it.attributes_json, '{}'::jsonb)
    ),
    updated_at = NOW()
WHERE it.variant_key IS DISTINCT FROM pg_temp.build_canonical_variant_key(
        it.org_id,
        it.name,
        COALESCE(it.attributes_json, '{}'::jsonb)
      );

-- pg_temp.* functions are auto-dropped at session end; no explicit DROP needed.
