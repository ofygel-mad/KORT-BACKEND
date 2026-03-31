-- CreateTable: ChapanOrderAttachment
CREATE TABLE "chapan_order_attachments" (
    "id"           TEXT NOT NULL,
    "order_id"     TEXT NOT NULL,
    "org_id"       TEXT NOT NULL,
    "file_name"    TEXT NOT NULL,
    "mime_type"    TEXT NOT NULL,
    "size_bytes"   INTEGER NOT NULL,
    "storage_path" TEXT NOT NULL,
    "uploaded_by"  TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapan_order_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chapan_order_attachments_order_id_idx" ON "chapan_order_attachments"("order_id");

-- AddForeignKey
ALTER TABLE "chapan_order_attachments"
    ADD CONSTRAINT "chapan_order_attachments_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "chapan_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
