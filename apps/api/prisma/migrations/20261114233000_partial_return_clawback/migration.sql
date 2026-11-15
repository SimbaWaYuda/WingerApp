-- Partial returns keep the original commission snapshot and restore stock once.
-- Existing commission, allocation, credit, and inventory rows are not rewritten.

ALTER TABLE "OrderItem" ADD COLUMN "returnedQuantity" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "CommissionClawback" (
    "id" TEXT NOT NULL,
    "orderItemCommissionId" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "merchandiseAmount" DECIMAL(12,2) NOT NULL,
    "commissionAmount" DECIMAL(12,2) NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionClawback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommissionClawback_returnRequestId_key" ON "CommissionClawback"("returnRequestId");
CREATE INDEX "CommissionClawback_orderItemCommissionId_idx" ON "CommissionClawback"("orderItemCommissionId");

ALTER TABLE "CommissionClawback"
  ADD CONSTRAINT "CommissionClawback_orderItemCommissionId_fkey"
  FOREIGN KEY ("orderItemCommissionId") REFERENCES "OrderItemCommission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionClawback"
  ADD CONSTRAINT "CommissionClawback_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
