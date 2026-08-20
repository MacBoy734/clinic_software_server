-- AlterTable
ALTER TABLE "bills" ADD COLUMN     "stage2_waive_reason" TEXT,
ADD COLUMN     "stage2_waived_at" TIMESTAMP(3),
ADD COLUMN     "stage2_waived_by" TEXT;
