-- AlterTable
ALTER TABLE "pharmacy_expenses" ADD COLUMN     "recorded_by" INTEGER;

-- AddForeignKey
ALTER TABLE "pharmacy_expenses" ADD CONSTRAINT "pharmacy_expenses_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
