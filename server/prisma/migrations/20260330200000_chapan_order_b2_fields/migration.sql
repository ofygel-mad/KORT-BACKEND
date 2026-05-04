-- Migration: Sprint 3 (B2) — Normalize order data model
-- Adds missing business fields to chapan_orders and chapan_order_items

-- Order-level fields
ALTER TABLE "chapan_orders"
  ADD COLUMN "postal_code"              TEXT,
  ADD COLUMN "order_date"               TIMESTAMPTZ,
  ADD COLUMN "order_discount"           DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "delivery_fee"             DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "bank_commission_percent"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "bank_commission_amount"   DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Item-level fields
ALTER TABLE "chapan_order_items"
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "length" TEXT;
