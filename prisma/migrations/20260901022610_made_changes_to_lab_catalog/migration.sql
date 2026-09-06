-- AlterTable
ALTER TABLE "lab_request_items" ADD COLUMN     "applied_ranges" JSONB,
ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "result_numeric" DOUBLE PRECISION,
ADD COLUMN     "unit" TEXT;
