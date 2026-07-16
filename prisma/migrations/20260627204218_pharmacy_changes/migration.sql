/*
  Warnings:

  - You are about to drop the column `quantity` on the `drug_stock` table. All the data in the column will be lost.
  - You are about to drop the column `retail_price` on the `drug_stock` table. All the data in the column will be lost.
  - Made the column `generic_name` on table `drug_stock` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
ALTER TYPE "PrescriptionStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "drug_stock" DROP COLUMN "quantity",
DROP COLUMN "retail_price",
ADD COLUMN     "batch_number" TEXT,
ADD COLUMN     "current_stock" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "normal_price" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotional_price" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "supplier" TEXT,
ADD COLUMN     "wholesale_price" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "generic_name" SET NOT NULL,
ALTER COLUMN "generic_name" SET DEFAULT '';

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by" TEXT;

-- CreateTable
CREATE TABLE "otc_sales" (
    "id" SERIAL NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL DEFAULT 'Walk-in Customer',
    "payment_method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "sold_by_id" INTEGER,
    "total" INTEGER NOT NULL DEFAULT 0,
    "sold_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otc_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otc_sale_items" (
    "id" SERIAL NOT NULL,
    "sale_id" INTEGER NOT NULL,
    "drug_id" INTEGER,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" INTEGER NOT NULL DEFAULT 0,
    "price_tier" TEXT NOT NULL DEFAULT 'normal',

    CONSTRAINT "otc_sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_settings" (
    "id" SERIAL NOT NULL,
    "prescription_markup_pct" INTEGER NOT NULL DEFAULT 25,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clinic_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "otc_sales_receipt_number_key" ON "otc_sales"("receipt_number");

-- AddForeignKey
ALTER TABLE "otc_sales" ADD CONSTRAINT "otc_sales_sold_by_id_fkey" FOREIGN KEY ("sold_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_items" ADD CONSTRAINT "otc_sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "otc_sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_items" ADD CONSTRAINT "otc_sale_items_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drug_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
