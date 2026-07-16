/*
  Warnings:

  - You are about to drop the column `age` on the `patients` table. All the data in the column will be lost.
  - You are about to drop the column `referred_by` on the `patients` table. All the data in the column will be lost.
  - You are about to drop the column `referrer_phone` on the `patients` table. All the data in the column will be lost.
  - You are about to drop the column `dosage` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `duration` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `medication` on the `prescriptions` table. All the data in the column will be lost.
  - You are about to drop the column `amount` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `complaint` on the `visits` table. All the data in the column will be lost.
  - You are about to drop the column `fee_status` on the `visits` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[national_id]` on the table `patients` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `staff` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `gender` to the `patients` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other');

-- CreateEnum
CREATE TYPE "VisitType" AS ENUM ('consultation', 'injection', 'family_planning', 'direct_lab');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'mpesa', 'insurance', 'other');

-- CreateEnum
CREATE TYPE "ChargeCategory" AS ENUM ('consultation', 'procedure', 'lab', 'medication');

-- CreateEnum
CREATE TYPE "PharmacyTxType" AS ENUM ('sale', 'refund', 'adjustment');

-- AlterEnum
ALTER TYPE "VisitStatus" ADD VALUE 'consultation_paid';

-- AlterTable
ALTER TABLE "drug_stock" ADD COLUMN     "reorder_level" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "retail_price" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "unit_cost" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "expiry_date" DROP NOT NULL;

-- AlterTable
ALTER TABLE "lab_requests" ADD COLUMN     "unit_cost" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "patients" DROP COLUMN "age",
DROP COLUMN "referred_by",
DROP COLUMN "referrer_phone",
ADD COLUMN     "allergies" TEXT,
ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "date_of_birth" TIMESTAMP(3),
ADD COLUMN     "gender" "Gender" NOT NULL,
ADD COLUMN     "national_id" TEXT;

-- AlterTable
ALTER TABLE "prescription_items" ADD COLUMN     "dispensed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dispensed_at" TIMESTAMP(3),
ADD COLUMN     "unit_cost" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "prescriptions" DROP COLUMN "dosage",
DROP COLUMN "duration",
DROP COLUMN "medication";

-- AlterTable
ALTER TABLE "visits" DROP COLUMN "amount",
DROP COLUMN "complaint",
DROP COLUMN "fee_status",
ADD COLUMN     "diagnosis" TEXT,
ADD COLUMN     "queue_number" INTEGER,
ADD COLUMN     "referred_by" TEXT,
ADD COLUMN     "referrer_phone" TEXT,
ADD COLUMN     "visit_type" "VisitType" NOT NULL DEFAULT 'direct_lab';

-- CreateTable
CREATE TABLE "vitals" (
    "id" SERIAL NOT NULL,
    "visit_id" INTEGER NOT NULL,
    "weight_kg" DOUBLE PRECISION,
    "height_cm" DOUBLE PRECISION,
    "bp_systolic" INTEGER,
    "bp_diastolic" INTEGER,
    "temperature" DOUBLE PRECISION,
    "pulse" INTEGER,
    "spo2" INTEGER,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_stock" (
    "id" SERIAL NOT NULL,
    "item_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reorder_at" INTEGER NOT NULL DEFAULT 0,
    "expiry" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_request_items" (
    "id" SERIAL NOT NULL,
    "lab_request_id" INTEGER NOT NULL,
    "lab_stock_id" INTEGER NOT NULL,
    "quantity_used" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" SERIAL NOT NULL,
    "visit_id" INTEGER NOT NULL,
    "consultation_fee" INTEGER NOT NULL DEFAULT 0,
    "consultation_fee_status" "FeeStatus" NOT NULL DEFAULT 'pending',
    "consultation_fee_status_paid_at" TIMESTAMP(3),
    "lab_fee" INTEGER NOT NULL DEFAULT 0,
    "medication_fee" INTEGER NOT NULL DEFAULT 0,
    "procedure_fee" INTEGER NOT NULL DEFAULT 0,
    "stage2_status" "FeeStatus" NOT NULL DEFAULT 'pending',
    "stage2_paid_at" TIMESTAMP(3),
    "total_amount" INTEGER NOT NULL DEFAULT 0,
    "fee_status" "FeeStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "bill_id" INTEGER NOT NULL,
    "cashier_id" INTEGER,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL DEFAULT 'cash',
    "reference" TEXT,
    "stage" INTEGER NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charge_templates" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" "ChargeCategory" NOT NULL,
    "amount" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_transactions" (
    "id" SERIAL NOT NULL,
    "type" "PharmacyTxType" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_expenses" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "category" TEXT,
    "incurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pharmacy_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_expenses" (
    "id" SERIAL NOT NULL,
    "description" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "category" TEXT,
    "recorded_by" INTEGER,
    "incurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clinic_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vitals_visit_id_key" ON "vitals"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "bills_visit_id_key" ON "bills"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "charge_templates_name_key" ON "charge_templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "patients_national_id_key" ON "patients"("national_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_username_key" ON "staff"("username");

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_request_items" ADD CONSTRAINT "lab_request_items_lab_request_id_fkey" FOREIGN KEY ("lab_request_id") REFERENCES "lab_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_request_items" ADD CONSTRAINT "lab_request_items_lab_stock_id_fkey" FOREIGN KEY ("lab_stock_id") REFERENCES "lab_stock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_expenses" ADD CONSTRAINT "clinic_expenses_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
