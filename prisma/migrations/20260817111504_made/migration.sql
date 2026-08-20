/*
  Warnings:

  - You are about to drop the column `procedure_done_by` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `procedure_name` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `procedure_notes` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `procedure_type` on the `visits` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "otc_sale_items" ADD COLUMN     "product_batch_id" INTEGER;

-- AlterTable
ALTER TABLE "prescription_items" ADD COLUMN     "product_batch_id" INTEGER;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "batch_id" INTEGER;

-- AlterTable
ALTER TABLE "visits" DROP COLUMN "procedure_done_by",
DROP COLUMN "procedure_name",
DROP COLUMN "procedure_notes",
DROP COLUMN "procedure_type";

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_product_batch_id_fkey" FOREIGN KEY ("product_batch_id") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_items" ADD CONSTRAINT "otc_sale_items_product_batch_id_fkey" FOREIGN KEY ("product_batch_id") REFERENCES "product_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
