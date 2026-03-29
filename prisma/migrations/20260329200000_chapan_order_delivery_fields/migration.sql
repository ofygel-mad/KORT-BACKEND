-- Add delivery, source, expected payment method, and shipping note fields to chapan_orders
ALTER TABLE "chapan_orders"
  ADD COLUMN IF NOT EXISTS "city"                    TEXT,
  ADD COLUMN IF NOT EXISTS "delivery_type"           TEXT,
  ADD COLUMN IF NOT EXISTS "source"                  TEXT,
  ADD COLUMN IF NOT EXISTS "expected_payment_method" TEXT,
  ADD COLUMN IF NOT EXISTS "shipping_note"           TEXT;
