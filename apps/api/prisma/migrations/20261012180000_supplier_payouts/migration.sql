ALTER TABLE "Supplier" ADD COLUMN "stripeAccountId" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "stripeConnectState" TEXT;
ALTER TABLE "Supplier" ADD COLUMN "stripePayoutsEnabled" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "Supplier_stripeAccountId_key" ON "Supplier"("stripeAccountId");
CREATE UNIQUE INDEX "Supplier_stripeConnectState_key" ON "Supplier"("stripeConnectState");

ALTER TABLE "OrderItemCommission" ADD COLUMN "stripeTransferId" TEXT;
ALTER TABLE "OrderItemCommission" ADD COLUMN "transferAmount" DECIMAL(12,2);
ALTER TABLE "OrderItemCommission" ADD COLUMN "transferCurrency" TEXT;
ALTER TABLE "OrderItemCommission" ADD COLUMN "transferReversed" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "OrderItemCommission_stripeTransferId_key" ON "OrderItemCommission"("stripeTransferId");
