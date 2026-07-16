-- AlterTable
ALTER TABLE "clinic_settings" ADD COLUMN     "address" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "lab_settings" JSONB,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "notifications" JSONB,
ADD COLUMN     "pharmacy_settings" JSONB,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "security" JSONB,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "visit_rules" JSONB;

-- CreateTable
CREATE TABLE "audit_log" (
    "id" SERIAL NOT NULL,
    "staff_id" INTEGER,
    "user" TEXT,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entity" TEXT,
    "entity_id" INTEGER,
    "ip_address" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_category_idx" ON "audit_log"("category");

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
