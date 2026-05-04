-- Add color field to chapan_order_items
ALTER TABLE "chapan_order_items" ADD COLUMN IF NOT EXISTS "color" TEXT;

-- Add internal_note to chapan_orders (for manager-only notes)
ALTER TABLE "chapan_orders" ADD COLUMN IF NOT EXISTS "internal_note" TEXT;
