ALTER TABLE "Product" ADD COLUMN "taxRatePercent" DECIMAL(5,2);

CREATE TABLE "SupplierCityTax" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "cityKey" TEXT NOT NULL,
    "taxRatePercent" DECIMAL(5,2) NOT NULL,

    CONSTRAINT "SupplierCityTax_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SupplierCityTax_supplierId_idx" ON "SupplierCityTax"("supplierId");

CREATE UNIQUE INDEX "SupplierCityTax_supplierId_cityKey_key" ON "SupplierCityTax"("supplierId", "cityKey");

ALTER TABLE "SupplierCityTax" ADD CONSTRAINT "SupplierCityTax_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
