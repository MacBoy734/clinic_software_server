-- AlterTable
ALTER TABLE "prescription_items" ADD COLUMN     "restock_reject_reason" TEXT,
ADD COLUMN     "restocked_at" TIMESTAMP(3),
ADD COLUMN     "restocked_by" TEXT,
ADD COLUMN     "returned_at" TIMESTAMP(3),
ADD COLUMN     "returned_by" TEXT;
