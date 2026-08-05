/*
  Warnings:

  - You are about to drop the column `batch_number` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `expiry_date` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `received_qty` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the column `requested_qty` on the `restock_requests` table. All the data in the column will be lost.
  - Added the required column `quantity` to the `restock_requests` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "products" DROP COLUMN "batch_number",
DROP COLUMN "expiry_date";

-- AlterTable
ALTER TABLE "restock_requests" DROP COLUMN "received_qty",
DROP COLUMN "requested_qty",
ADD COLUMN     "quantity" INTEGER NOT NULL;
