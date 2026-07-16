/*
  Warnings:

  - You are about to drop the column `date_of_birth` on the `patients` table. All the data in the column will be lost.
  - Added the required column `age` to the `patients` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "patients" DROP COLUMN "date_of_birth",
ADD COLUMN     "age" INTEGER NOT NULL;
