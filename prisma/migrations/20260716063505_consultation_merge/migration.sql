-- AlterEnum
ALTER TYPE "ChargeCategory" ADD VALUE 'family_planning';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PrescriptionItemStatus" ADD VALUE 'returned';
ALTER TYPE "PrescriptionItemStatus" ADD VALUE 'restocked';
ALTER TYPE "PrescriptionItemStatus" ADD VALUE 'cancelled';

-- AlterTable
ALTER TABLE "prescription_items" ADD COLUMN     "drug_id" INTEGER,
ADD COLUMN     "form" TEXT,
ADD COLUMN     "return_reason" TEXT;

-- AlterTable
ALTER TABLE "visits" ADD COLUMN     "procedure_done_by" TEXT,
ADD COLUMN     "procedure_name" TEXT,
ADD COLUMN     "procedure_notes" TEXT,
ADD COLUMN     "procedure_type" TEXT;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drug_stock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
