/*
  Warnings:

  - Made the column `recorded_by` on table `clinic_expenses` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "clinic_expenses" DROP CONSTRAINT "clinic_expenses_recorded_by_fkey";

-- AlterTable
ALTER TABLE "clinic_expenses" ALTER COLUMN "recorded_by" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "clinic_expenses" ADD CONSTRAINT "clinic_expenses_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
