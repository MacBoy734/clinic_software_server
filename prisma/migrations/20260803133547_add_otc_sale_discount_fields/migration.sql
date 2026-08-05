/*
  Warnings:

  - The values [balance] on the enum `PaymentMethod` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PaymentMethod_new" AS ENUM ('cash', 'mpesa', 'insurance', 'credit', 'other');
ALTER TABLE "public"."otc_sales" ALTER COLUMN "payment_method" DROP DEFAULT;
ALTER TABLE "public"."payments" ALTER COLUMN "method" DROP DEFAULT;
ALTER TABLE "otc_sales" ALTER COLUMN "payment_method" TYPE "PaymentMethod_new" USING ("payment_method"::text::"PaymentMethod_new");
ALTER TABLE "otc_sale_payments" ALTER COLUMN "method" TYPE "PaymentMethod_new" USING ("method"::text::"PaymentMethod_new");
ALTER TABLE "payments" ALTER COLUMN "method" TYPE "PaymentMethod_new" USING ("method"::text::"PaymentMethod_new");
ALTER TYPE "PaymentMethod" RENAME TO "PaymentMethod_old";
ALTER TYPE "PaymentMethod_new" RENAME TO "PaymentMethod";
DROP TYPE "public"."PaymentMethod_old";
ALTER TABLE "otc_sales" ALTER COLUMN "payment_method" SET DEFAULT 'cash';
ALTER TABLE "payments" ALTER COLUMN "method" SET DEFAULT 'cash';
COMMIT;

-- AlterTable
ALTER TABLE "otc_sales" ADD COLUMN     "discount_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "discount_by" TEXT,
ADD COLUMN     "discount_reason" TEXT;
