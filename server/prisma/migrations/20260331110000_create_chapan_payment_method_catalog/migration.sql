-- CreateTable: chapan_catalog_payment_methods
CREATE TABLE "chapan_catalog_payment_methods" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chapan_catalog_payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chapan_catalog_payment_methods_org_id_name_key"
ON "chapan_catalog_payment_methods"("org_id", "name");

-- AddForeignKey
ALTER TABLE "chapan_catalog_payment_methods"
ADD CONSTRAINT "chapan_catalog_payment_methods_org_id_fkey"
FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
