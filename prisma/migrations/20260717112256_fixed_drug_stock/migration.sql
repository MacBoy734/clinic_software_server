-- CreateTable
CREATE TABLE "lab_stock_usage" (
    "id" SERIAL NOT NULL,
    "lab_request_item_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "item_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "quantity_deducted" INTEGER NOT NULL DEFAULT 0,
    "unit" TEXT,
    "unit_cost" INTEGER NOT NULL DEFAULT 0,
    "recorded_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_stock_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lab_stock_usage_stock_item_id_idx" ON "lab_stock_usage"("stock_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "lab_stock_usage_lab_request_item_id_stock_item_id_key" ON "lab_stock_usage"("lab_request_item_id", "stock_item_id");

-- AddForeignKey
ALTER TABLE "lab_stock_usage" ADD CONSTRAINT "lab_stock_usage_lab_request_item_id_fkey" FOREIGN KEY ("lab_request_item_id") REFERENCES "lab_request_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_stock_usage" ADD CONSTRAINT "lab_stock_usage_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "lab_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
