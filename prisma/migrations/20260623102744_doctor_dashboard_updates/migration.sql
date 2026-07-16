/*
  Warnings:

  - You are about to drop the column `lab_stock_id` on the `lab_request_items` table. All the data in the column will be lost.
  - You are about to drop the column `quantity_used` on the `lab_request_items` table. All the data in the column will be lost.
  - You are about to drop the column `result` on the `lab_requests` table. All the data in the column will be lost.
  - You are about to drop the column `test_name` on the `lab_requests` table. All the data in the column will be lost.
  - You are about to drop the column `unit_cost` on the `lab_requests` table. All the data in the column will be lost.
  - You are about to drop the column `dispensed` on the `prescription_items` table. All the data in the column will be lost.
  - You are about to drop the `lab_stock` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `test_name` to the `lab_request_items` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updated_at` to the `lab_request_items` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PrescriptionItemStatus" AS ENUM ('pending', 'issued', 'declined');

-- CreateEnum
CREATE TYPE "LabUrgency" AS ENUM ('routine', 'urgent', 'stat');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'fulfilled', 'cancelled');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PrescriptionStatus" ADD VALUE 'issued';
ALTER TYPE "PrescriptionStatus" ADD VALUE 'returned';

-- DropForeignKey
ALTER TABLE "clinic_expenses" DROP CONSTRAINT "clinic_expenses_recorded_by_fkey";

-- DropForeignKey
ALTER TABLE "lab_request_items" DROP CONSTRAINT "lab_request_items_lab_stock_id_fkey";

-- AlterTable
ALTER TABLE "clinic_expenses" ADD COLUMN     "category" TEXT,
ALTER COLUMN "recorded_by" DROP NOT NULL;

-- AlterTable
ALTER TABLE "drug_stock" ADD COLUMN     "category" TEXT,
ADD COLUMN     "form" TEXT,
ADD COLUMN     "generic_name" TEXT,
ADD COLUMN     "strength" TEXT;

-- AlterTable
ALTER TABLE "lab_request_items" DROP COLUMN "lab_stock_id",
DROP COLUMN "quantity_used",
ADD COLUMN     "category" TEXT,
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "reference_range" TEXT,
ADD COLUMN     "result" TEXT,
ADD COLUMN     "status" "LabStatus" NOT NULL DEFAULT 'pending',
ADD COLUMN     "test_name" TEXT NOT NULL,
ADD COLUMN     "unit_cost" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "lab_requests" DROP COLUMN "result",
DROP COLUMN "test_name",
DROP COLUMN "unit_cost",
ADD COLUMN     "ordered_by" TEXT,
ADD COLUMN     "urgency" "LabUrgency" NOT NULL DEFAULT 'routine';

-- AlterTable
ALTER TABLE "pharmacy_expenses" ADD COLUMN     "category" TEXT;

-- AlterTable
ALTER TABLE "prescription_items" DROP COLUMN "dispensed",
ADD COLUMN     "decline_reason" TEXT,
ADD COLUMN     "status" "PrescriptionItemStatus" NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "prescribed_by" TEXT,
ADD COLUMN     "return_reason" TEXT,
ADD COLUMN     "returned_at" TIMESTAMP(3),
ADD COLUMN     "returned_by" TEXT,
ADD COLUMN     "verified_at" TIMESTAMP(3),
ADD COLUMN     "verified_by" TEXT,
ADD COLUMN     "verify_notes" TEXT;

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "assessment" TEXT,
ADD COLUMN     "chief_complaint" TEXT,
ADD COLUMN     "diagnosis_code" TEXT,
ADD COLUMN     "has_lab_results" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "medication_verification" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "objective" TEXT,
ADD COLUMN     "plan" TEXT,
ADD COLUMN     "subjective" TEXT;

-- AlterTable
ALTER TABLE "vitals" ADD COLUMN     "respiratory_rate" INTEGER,
ADD COLUMN     "vitals_notes" TEXT;

-- DropTable
DROP TABLE "lab_stock";

-- CreateTable
CREATE TABLE "pharmacy_orders" (
    "id" SERIAL NOT NULL,
    "department" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "fulfilled_by" TEXT,
    "fulfilled_at" TIMESTAMP(3),
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pharmacy_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pharmacy_order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,

    CONSTRAINT "pharmacy_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "staff_id" INTEGER,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "visit_id" INTEGER,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "pharmacy_order_items" ADD CONSTRAINT "pharmacy_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "pharmacy_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinic_expenses" ADD CONSTRAINT "clinic_expenses_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
