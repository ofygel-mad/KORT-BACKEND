-- Keep the dedicated demo account out of customer ownership after
-- ownership has already been transferred to a real customer user.

WITH demo_user AS (
  SELECT id
  FROM "users"
  WHERE "email" = 'admin@kort.local'
)
UPDATE "memberships" AS m
SET
  "role" = 'admin',
  "updated_at" = NOW()
FROM demo_user du
WHERE m."user_id" = du.id
  AND m."role" = 'owner'
  AND EXISTS (
    SELECT 1
    FROM "organizations" o
    WHERE o."id" = m."org_id"
      AND o."slug" <> 'demo-company'
  )
  AND EXISTS (
    SELECT 1
    FROM "memberships" other_owner
    WHERE other_owner."org_id" = m."org_id"
      AND other_owner."status" = 'active'
      AND other_owner."role" = 'owner'
      AND other_owner."user_id" <> du.id
  );
