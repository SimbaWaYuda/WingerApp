-- Locked per-supplier merchandise, delivery, and tax from checkout.
CREATE TABLE "OrderShipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "merchandise" DECIMAL(12,2) NOT NULL,
    "deliveryFee" DECIMAL(12,2) NOT NULL,
    "merchandiseTax" DECIMAL(12,2) NOT NULL,
    "deliveryTax" DECIMAL(12,2) NOT NULL,
    "paymentMerchandise" DECIMAL(12,2) NOT NULL,
    "paymentDelivery" DECIMAL(12,2) NOT NULL,
    "paymentTax" DECIMAL(12,2) NOT NULL,
    "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderShipment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderShipment_orderId_supplierId_key" ON "OrderShipment"("orderId", "supplierId");
CREATE INDEX "OrderShipment_supplierId_idx" ON "OrderShipment"("supplierId");

ALTER TABLE "OrderShipment" ADD CONSTRAINT "OrderShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderShipment" ADD CONSTRAINT "OrderShipment_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
