-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "discount_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discount_reason" TEXT;
