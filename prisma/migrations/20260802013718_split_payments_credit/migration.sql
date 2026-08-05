/*
  Warnings:

  - You are about to drop the column `unit_cost` on the `product_batches` table. All the data in the column will be lost.
  - The `batch_number` column on the `product_batches` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `tax_class` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `unit_cost` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `unit_cost` on the `restock_requests` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[batch_number]` on the table `product_batches` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentMethod" ADD VALUE 'balance';
ALTER TYPE "PaymentMethod" ADD VALUE 'credit';

-- AlterTable
ALTER TABLE "otc_sales" ADD COLUMN     "customer_id" INTEGER;

-- AlterTable
ALTER TABLE "product_batches" DROP COLUMN "unit_cost",
DROP COLUMN "batch_number",
ADD COLUMN     "batch_number" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "products" DROP COLUMN "tax_class",
DROP COLUMN "unit_cost",
ALTER COLUMN "unit" SET DEFAULT 'piece';

-- AlterTable
ALTER TABLE "restock_requests" DROP COLUMN "unit_cost";

-- DropEnum
DROP TYPE "TaxClass";

-- CreateTable
CREATE TABLE "pharmacy_customers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otc_sale_payments" (
    "id" SERIAL NOT NULL,
    "sale_id" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otc_sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_payments" (
    "id" SERIAL NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "staff_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pharmacy_customers_phone_key" ON "pharmacy_customers"("phone");

-- CreateIndex
CREATE INDEX "otc_sale_payments_sale_id_idx" ON "otc_sale_payments"("sale_id");

-- CreateIndex
CREATE INDEX "customer_payments_customer_id_created_at_idx" ON "customer_payments"("customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_batch_number_key" ON "product_batches"("batch_number");

-- CreateIndex
CREATE UNIQUE INDEX "product_batches_product_id_batch_number_key" ON "product_batches"("product_id", "batch_number");

-- AddForeignKey
ALTER TABLE "otc_sales" ADD CONSTRAINT "otc_sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "pharmacy_customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_payments" ADD CONSTRAINT "otc_sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "otc_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "pharmacy_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
