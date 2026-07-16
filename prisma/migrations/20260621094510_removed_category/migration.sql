/*
  Warnings:

  - You are about to drop the column `category` on the `clinic_expenses` table. All the data in the column will be lost.
  - You are about to drop the column `category` on the `pharmacy_expenses` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "clinic_expenses" DROP COLUMN "category";

-- AlterTable
ALTER TABLE "pharmacy_expenses" DROP COLUMN "category";
