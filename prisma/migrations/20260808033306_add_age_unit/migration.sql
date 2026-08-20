/*
  Warnings:

  - The values [reception,admin] on the enum `OrderDepartment` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "OrderDepartment_new" AS ENUM ('doctor', 'lab');
ALTER TABLE "pharmacy_orders" ALTER COLUMN "department" TYPE "OrderDepartment_new" USING ("department"::text::"OrderDepartment_new");
ALTER TYPE "OrderDepartment" RENAME TO "OrderDepartment_old";
ALTER TYPE "OrderDepartment_new" RENAME TO "OrderDepartment";
DROP TYPE "public"."OrderDepartment_old";
COMMIT;

-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "consultation_fee_waive_reason" TEXT,
ADD COLUMN     "consultation_fee_waived_at" TIMESTAMP(3),
ADD COLUMN     "consultation_fee_waived_by" TEXT;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "age_unit" TEXT NOT NULL DEFAULT 'years';
