/*
  Warnings:

  - The values [dispensed] on the enum `PrescriptionStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PrescriptionStatus_new" AS ENUM ('pending', 'issued', 'returned', 'cancelled');
ALTER TABLE "public"."prescriptions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "prescriptions" ALTER COLUMN "status" TYPE "PrescriptionStatus_new" USING ("status"::text::"PrescriptionStatus_new");
ALTER TYPE "PrescriptionStatus" RENAME TO "PrescriptionStatus_old";
ALTER TYPE "PrescriptionStatus_new" RENAME TO "PrescriptionStatus";
DROP TYPE "public"."PrescriptionStatus_old";
ALTER TABLE "prescriptions" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "shelf_location" TEXT;
