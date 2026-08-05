/*
  Warnings:

  - You are about to drop the column `amount_paid` on the `external_referrals` table. All the data in the column will be lost.
  - You are about to drop the column `commission_rate` on the `external_referrals` table. All the data in the column will be lost.
  - You are about to drop the column `referred_at` on the `external_referrals` table. All the data in the column will be lost.
  - You are about to drop the column `test_cost` on the `external_referrals` table. All the data in the column will be lost.
  - You are about to drop the column `test_ordered` on the `external_referrals` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "external_referrals" DROP COLUMN "amount_paid",
DROP COLUMN "commission_rate",
DROP COLUMN "referred_at",
DROP COLUMN "test_cost",
DROP COLUMN "test_ordered",
ALTER COLUMN "referrer_facility" DROP NOT NULL,
ALTER COLUMN "commission_amount" DROP NOT NULL;
