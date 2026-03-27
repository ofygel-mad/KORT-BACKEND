-- Add organization fields used for document autofill (Z-2 invoice template and future forms)
ALTER TABLE "organizations"
  ADD COLUMN "shipment_responsible_name" TEXT,
  ADD COLUMN "shipment_responsible_position" TEXT,
  ADD COLUMN "transport_organization" TEXT,
  ADD COLUMN "attorney_number" TEXT,
  ADD COLUMN "attorney_date" TEXT,
  ADD COLUMN "attorney_issued_by" TEXT;
