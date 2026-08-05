/*
  Warnings:

  - You are about to drop the column `current_stock` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `direct_restock` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `item_id` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `item_name` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `supplier` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `unit_cost` on the `restock_requests` table. All the data in the column will be lost.
  - Made the column `batch_number` on table `restock_requests` required. This step will fail if there are existing NULL values in that column.
  - Made the column `expiry_date` on table `restock_requests` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "restock_requests" DROP COLUMN "current_stock",
DROP COLUMN "direct_restock",
DROP COLUMN "item_id",
DROP COLUMN "item_name",
DROP COLUMN "supplier",
DROP COLUMN "unit_cost",
ADD COLUMN     "drug_stock_id" INTEGER,
ADD COLUMN     "lab_stock_id" INTEGER,
ALTER COLUMN "received_qty" DROP DEFAULT,
ALTER COLUMN "batch_number" SET NOT NULL,
ALTER COLUMN "expiry_date" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_drug_stock_id_fkey" FOREIGN KEY ("drug_stock_id") REFERENCES "drug_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_lab_stock_id_fkey" FOREIGN KEY ("lab_stock_id") REFERENCES "lab_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
