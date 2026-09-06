-- CreateEnum
CREATE TYPE "ReturnLineDisposition" AS ENUM ('restock', 'writeoff');

-- AlterTable
ALTER TABLE "customer_payments" ADD COLUMN     "is_credit_note" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "otc_sale_returns" (
    "id" SERIAL NOT NULL,
    "return_number" TEXT NOT NULL,
    "sale_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "cash_refund_amount" INTEGER NOT NULL DEFAULT 0,
    "credit_note_amount" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "returned_by_id" INTEGER,
    "returned_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otc_sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otc_sale_return_items" (
    "id" SERIAL NOT NULL,
    "return_id" INTEGER NOT NULL,
    "sale_item_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL DEFAULT 0,
    "disposition" "ReturnLineDisposition" NOT NULL,
    "note" TEXT,

    CONSTRAINT "otc_sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "otc_sale_returns_return_number_key" ON "otc_sale_returns"("return_number");

-- CreateIndex
CREATE INDEX "otc_sale_returns_sale_id_idx" ON "otc_sale_returns"("sale_id");

-- CreateIndex
CREATE INDEX "otc_sale_returns_created_at_idx" ON "otc_sale_returns"("created_at");

-- CreateIndex
CREATE INDEX "otc_sale_return_items_return_id_idx" ON "otc_sale_return_items"("return_id");

-- CreateIndex
CREATE INDEX "otc_sale_return_items_sale_item_id_idx" ON "otc_sale_return_items"("sale_item_id");

-- AddForeignKey
ALTER TABLE "otc_sale_returns" ADD CONSTRAINT "otc_sale_returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "otc_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_returns" ADD CONSTRAINT "otc_sale_returns_returned_by_id_fkey" FOREIGN KEY ("returned_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_return_items" ADD CONSTRAINT "otc_sale_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "otc_sale_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_return_items" ADD CONSTRAINT "otc_sale_return_items_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "otc_sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
