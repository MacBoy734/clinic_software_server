-- CreateEnum
CREATE TYPE "RestockStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "RestockDepartment" AS ENUM ('pharmacy', 'lab');

-- CreateTable
CREATE TABLE "restock_requests" (
    "id" SERIAL NOT NULL,
    "department" "RestockDepartment" NOT NULL,
    "item_id" INTEGER NOT NULL,
    "item_name" TEXT NOT NULL,
    "current_stock" INTEGER NOT NULL DEFAULT 0,
    "requested_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "unit_cost" INTEGER NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "batch_number" TEXT,
    "expiry_date" TIMESTAMP(3),
    "notes" TEXT,
    "direct_restock" BOOLEAN NOT NULL DEFAULT false,
    "status" "RestockStatus" NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "verified_by" TEXT,
    "verified_at" TIMESTAMP(3),
    "verification_notes" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restock_requests_pkey" PRIMARY KEY ("id")
);
