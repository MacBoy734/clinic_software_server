-- AlterTable
ALTER TABLE "lab_request_items" ADD COLUMN     "catalog_id" INTEGER,
ADD COLUMN     "flagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "result_data" JSONB,
ADD COLUMN     "result_notes" TEXT;

-- CreateTable
CREATE TABLE "lab_test_catalog" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "reference_range" TEXT,
    "unit_cost" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "result_template" JSONB,

    CONSTRAINT "lab_test_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lab_test_catalog_name_key" ON "lab_test_catalog"("name");

-- AddForeignKey
ALTER TABLE "lab_request_items" ADD CONSTRAINT "lab_request_items_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "lab_test_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
