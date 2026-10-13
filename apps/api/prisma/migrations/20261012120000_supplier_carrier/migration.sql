ALTER TABLE "Supplier" ADD COLUMN "carrier" TEXT NOT NULL DEFAULT 'supplier';
ALTER TABLE "Supplier" ADD COLUMN "courierName" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "carrier" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "courierName" TEXT;
