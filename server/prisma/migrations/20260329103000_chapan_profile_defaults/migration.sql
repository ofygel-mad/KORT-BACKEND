ALTER TABLE "chapan_profiles"
  ALTER COLUMN "display_name" SET DEFAULT 'Экспериментальный модуль',
  ALTER COLUMN "descriptor" SET DEFAULT 'Рабочая зона модуля',
  ALTER COLUMN "order_prefix" SET DEFAULT 'EXP',
  ALTER COLUMN "public_intake_title" SET DEFAULT 'Оставьте заявку';

UPDATE "chapan_profiles"
SET
  "display_name" = 'Чапан',
  "order_prefix" = 'ЧП'
WHERE "org_id" IN (
  SELECT DISTINCT m."org_id"
  FROM "memberships" m
  INNER JOIN "users" u ON u."id" = m."user_id"
  INNER JOIN "organizations" o ON o."id" = m."org_id"
  WHERE m."role" = 'owner'
    AND m."status" = 'active'
    AND (
      u."email" = 'admin@kort.local'
      OR o."slug" = 'demo-company'
    )
);
