-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('in_progress', 'submitted', 'approved');

-- CreateEnum
CREATE TYPE "StocktakeReason" AS ENUM ('expired', 'damaged', 'broken', 'stolen', 'miscounted', 'misplaced', 'found_unrecorded', 'other');

-- AlterEnum
ALTER TYPE "MovementReason" ADD VALUE 'stocktake';

-- AlterTable
ALTER TABLE "external_referrals" ADD COLUMN     "amount_paid" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "last_counted_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "stocktake_sessions" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'in_progress',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "started_by_id" INTEGER,
    "started_by" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_by" TEXT,
    "submitted_at" TIMESTAMP(3),
    "reviewed_by_id" INTEGER,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "review_notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktake_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stocktake_items" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "shelf_location" TEXT,
    "counted_qty" INTEGER,
    "system_qty" INTEGER,
    "variance" INTEGER,
    "counted_at" TIMESTAMP(3),
    "counted_by" TEXT,
    "reason" "StocktakeReason",
    "note" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stocktake_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stocktake_sessions_status_started_at_idx" ON "stocktake_sessions"("status", "started_at");

-- CreateIndex
CREATE INDEX "stocktake_items_session_id_shelf_location_idx" ON "stocktake_items"("session_id", "shelf_location");

-- CreateIndex
CREATE INDEX "stocktake_items_product_id_idx" ON "stocktake_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stocktake_items_session_id_product_id_key" ON "stocktake_items"("session_id", "product_id");

-- AddForeignKey
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_sessions" ADD CONSTRAINT "stocktake_sessions_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "stocktake_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stocktake_items" ADD CONSTRAINT "stocktake_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
