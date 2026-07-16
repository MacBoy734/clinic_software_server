-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'paid');

-- CreateTable
CREATE TABLE "external_referrals" (
    "id" SERIAL NOT NULL,
    "visit_id" INTEGER NOT NULL,
    "referrer_name" TEXT NOT NULL,
    "referrer_facility" TEXT NOT NULL,
    "referrer_phone" TEXT,
    "test_ordered" TEXT NOT NULL,
    "test_cost" INTEGER NOT NULL,
    "commission_rate" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "commission_amount" INTEGER NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "referred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "paid_by" TEXT,
    "amount_paid" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_referrals_visit_id_key" ON "external_referrals"("visit_id");

-- AddForeignKey
ALTER TABLE "external_referrals" ADD CONSTRAINT "external_referrals_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
