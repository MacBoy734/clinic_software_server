/*
  Warnings:

  - You are about to drop the column `lab_settings` on the `clinic_settings` table. All the data in the column will be lost.
  - You are about to drop the column `notifications` on the `clinic_settings` table. All the data in the column will be lost.
  - You are about to drop the column `visit_rules` on the `clinic_settings` table. All the data in the column will be lost.
  - You are about to drop the column `drug_id` on the `otc_sale_items` table. All the data in the column will be lost.
  - You are about to drop the column `drug_id` on the `prescription_items` table. All the data in the column will be lost.
  - You are about to drop the column `drug_stock_id` on the `restock_requests` table. All the data in the column will be lost.
  - You are about to drop the `drug_stock` table. If the table is not empty, all the data it contains will be lost.
  - Changed the type of `department` on the `pharmacy_orders` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ProductCategory" AS ENUM ('medication', 'consumable', 'general');

-- CreateEnum
CREATE TYPE "TaxClass" AS ENUM ('exempt', 'zero_rated', 'standard');

-- CreateEnum
CREATE TYPE "MovementReason" AS ENUM ('sale', 'dispense', 'issue', 'restock', 'return_to_stock', 'adjustment', 'writeoff');

-- CreateEnum
CREATE TYPE "OrderDepartment" AS ENUM ('doctor', 'lab', 'reception', 'admin');

-- DropForeignKey
ALTER TABLE "otc_sale_items" DROP CONSTRAINT "otc_sale_items_drug_id_fkey";

-- DropForeignKey
ALTER TABLE "prescription_items" DROP CONSTRAINT "prescription_items_drug_id_fkey";

-- DropForeignKey
ALTER TABLE "restock_requests" DROP CONSTRAINT "restock_requests_drug_stock_id_fkey";

-- AlterTable
ALTER TABLE "clinic_settings" DROP COLUMN "lab_settings",
DROP COLUMN "notifications",
DROP COLUMN "visit_rules";

-- AlterTable
ALTER TABLE "otc_sale_items" DROP COLUMN "drug_id",
ADD COLUMN     "product_id" INTEGER,
ADD COLUMN     "tax_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unit_cost" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "otc_sales" ADD COLUMN     "subtotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_total" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "pharmacy_order_items" ADD COLUMN     "fulfilled_qty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "product_id" INTEGER;

-- AlterTable
ALTER TABLE "pharmacy_orders" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancelled_by" TEXT,
ADD COLUMN     "fulfilled_by_id" INTEGER,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "requested_by_id" INTEGER,
DROP COLUMN "department",
ADD COLUMN     "department" "OrderDepartment" NOT NULL;

-- AlterTable
ALTER TABLE "prescription_items" DROP COLUMN "drug_id",
ADD COLUMN     "product_id" INTEGER;

-- AlterTable
ALTER TABLE "restock_requests" DROP COLUMN "drug_stock_id",
ADD COLUMN     "product_id" INTEGER,
ADD COLUMN     "requested_by_id" INTEGER,
ADD COLUMN     "unit_cost" INTEGER,
ALTER COLUMN "received_qty" SET DEFAULT 0,
ALTER COLUMN "batch_number" DROP NOT NULL,
ALTER COLUMN "expiry_date" DROP NOT NULL;

-- DropTable
DROP TABLE "drug_stock";

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "category" "ProductCategory" NOT NULL DEFAULT 'medication',
    "sub_category" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'units',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "generic_name" TEXT,
    "form" TEXT,
    "strength" TEXT,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "reorder_level" INTEGER NOT NULL DEFAULT 50,
    "unit_cost" INTEGER NOT NULL DEFAULT 0,
    "normal_price" INTEGER NOT NULL DEFAULT 0,
    "promotional_price" INTEGER NOT NULL DEFAULT 0,
    "wholesale_price" INTEGER NOT NULL DEFAULT 0,
    "tax_class" "TaxClass" NOT NULL DEFAULT 'exempt',
    "supplier" TEXT,
    "batch_number" TEXT,
    "expiry_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "MovementReason" NOT NULL,
    "ref_type" TEXT,
    "ref_id" INTEGER,
    "balance_after" INTEGER NOT NULL,
    "note" TEXT,
    "staff_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "products_name_key" ON "products"("name");

-- CreateIndex
CREATE INDEX "products_category_is_active_idx" ON "products"("category", "is_active");

-- CreateIndex
CREATE INDEX "products_category_name_idx" ON "products"("category", "name");

-- CreateIndex
CREATE INDEX "products_category_sub_category_idx" ON "products"("category", "sub_category");

-- CreateIndex
CREATE INDEX "products_name_idx" ON "products"("name");

-- CreateIndex
CREATE INDEX "stock_movements_product_id_created_at_idx" ON "stock_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_reason_created_at_idx" ON "stock_movements"("reason", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_ref_type_ref_id_idx" ON "stock_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "audit_log_staff_id_idx" ON "audit_log"("staff_id");

-- CreateIndex
CREATE INDEX "bills_fee_status_idx" ON "bills"("fee_status");

-- CreateIndex
CREATE INDEX "lab_request_items_lab_request_id_idx" ON "lab_request_items"("lab_request_id");

-- CreateIndex
CREATE INDEX "lab_request_items_catalog_id_idx" ON "lab_request_items"("catalog_id");

-- CreateIndex
CREATE INDEX "lab_requests_visit_id_idx" ON "lab_requests"("visit_id");

-- CreateIndex
CREATE INDEX "lab_requests_status_requested_at_idx" ON "lab_requests"("status", "requested_at");

-- CreateIndex
CREATE INDEX "notifications_target_staff_id_is_read_idx" ON "notifications"("target_staff_id", "is_read");

-- CreateIndex
CREATE INDEX "otc_sale_items_sale_id_idx" ON "otc_sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "otc_sale_items_product_id_idx" ON "otc_sale_items"("product_id");

-- CreateIndex
CREATE INDEX "otc_sales_sold_at_idx" ON "otc_sales"("sold_at");

-- CreateIndex
CREATE INDEX "patients_name_idx" ON "patients"("name");

-- CreateIndex
CREATE INDEX "patients_phone_idx" ON "patients"("phone");

-- CreateIndex
CREATE INDEX "payments_bill_id_idx" ON "payments"("bill_id");

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- CreateIndex
CREATE INDEX "pharmacy_order_items_order_id_idx" ON "pharmacy_order_items"("order_id");

-- CreateIndex
CREATE INDEX "pharmacy_order_items_product_id_idx" ON "pharmacy_order_items"("product_id");

-- CreateIndex
CREATE INDEX "pharmacy_orders_status_requested_at_idx" ON "pharmacy_orders"("status", "requested_at");

-- CreateIndex
CREATE INDEX "pharmacy_orders_department_status_idx" ON "pharmacy_orders"("department", "status");

-- CreateIndex
CREATE INDEX "prescription_items_prescription_id_idx" ON "prescription_items"("prescription_id");

-- CreateIndex
CREATE INDEX "prescription_items_product_id_idx" ON "prescription_items"("product_id");

-- CreateIndex
CREATE INDEX "prescriptions_visit_id_idx" ON "prescriptions"("visit_id");

-- CreateIndex
CREATE INDEX "prescriptions_status_idx" ON "prescriptions"("status");

-- CreateIndex
CREATE INDEX "restock_requests_status_department_idx" ON "restock_requests"("status", "department");

-- CreateIndex
CREATE INDEX "restock_requests_product_id_status_idx" ON "restock_requests"("product_id", "status");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "visits_status_arrived_at_idx" ON "visits"("status", "arrived_at");

-- CreateIndex
CREATE INDEX "visits_patient_id_arrived_at_idx" ON "visits"("patient_id", "arrived_at");

-- CreateIndex
CREATE INDEX "visits_doctor_id_idx" ON "visits"("doctor_id");

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_orders" ADD CONSTRAINT "pharmacy_orders_fulfilled_by_id_fkey" FOREIGN KEY ("fulfilled_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pharmacy_order_items" ADD CONSTRAINT "pharmacy_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otc_sale_items" ADD CONSTRAINT "otc_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
