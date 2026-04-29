-- AlterTable
ALTER TABLE "chapan_clients" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "crm_customer_id" TEXT;

-- CreateIndex
CREATE INDEX "chapan_clients_org_id_phone_idx" ON "chapan_clients"("org_id", "phone");

-- CreateIndex
CREATE INDEX "chapan_clients_crm_customer_id_idx" ON "chapan_clients"("crm_customer_id");
