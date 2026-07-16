-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "target_role" JSONB,
ADD COLUMN     "target_staff_id" INTEGER;
