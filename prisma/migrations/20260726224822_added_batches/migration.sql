-- CreateTable
CREATE TABLE "product_batches" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "batch_number" TEXT NOT NULL,
    "expiry_date" TIMESTAMP(3),
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "unit_cost" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_by" TEXT,
    "notes" TEXT,
    "is_exhausted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "product_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_batches_product_id_expiry_date_idx" ON "product_batches"("product_id", "expiry_date");

-- CreateIndex
CREATE INDEX "product_batches_product_id_is_exhausted_idx" ON "product_batches"("product_id", "is_exhausted");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_product_id_batch_number_key" ON "product_batches"("product_id", "batch_number");

-- AddForeignKey
ALTER TABLE "product_batches" ADD CONSTRAINT "product_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
