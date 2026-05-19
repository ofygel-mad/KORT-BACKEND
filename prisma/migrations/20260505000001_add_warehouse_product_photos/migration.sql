-- CreateTable
CREATE TABLE "warehouse_product_photos" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_product_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "warehouse_product_photos_product_id_idx" ON "warehouse_product_photos"("product_id");

-- AddForeignKey
ALTER TABLE "warehouse_product_photos" ADD CONSTRAINT "warehouse_product_photos_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "warehouse_product_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
