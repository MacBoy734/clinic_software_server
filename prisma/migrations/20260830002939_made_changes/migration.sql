-- AlterTable
ALTER TABLE "pharmacy_customers" ADD COLUMN     "credit_limit" INTEGER NOT NULL DEFAULT 5000;

-- CreateIndex
CREATE INDEX "customer_payments_created_at_idx" ON "customer_payments"("created_at");

-- CreateIndex
CREATE INDEX "otc_sale_payments_method_created_at_idx" ON "otc_sale_payments"("method", "created_at");

-- CreateIndex
CREATE INDEX "otc_sale_payments_created_at_idx" ON "otc_sale_payments"("created_at");

-- CreateIndex
CREATE INDEX "otc_sales_customer_id_idx" ON "otc_sales"("customer_id");

-- CreateIndex
CREATE INDEX "pharmacy_expenses_incurred_at_idx" ON "pharmacy_expenses"("incurred_at");
