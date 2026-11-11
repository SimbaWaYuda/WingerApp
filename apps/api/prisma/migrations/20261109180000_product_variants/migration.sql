-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '',
    "size" TEXT NOT NULL DEFAULT '',
    "colorHex" TEXT,
    "sku" TEXT,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "stockStatus" "StockStatus" NOT NULL DEFAULT 'IN_STOCK',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ProductImage" ADD COLUMN "variantId" TEXT,
ADD COLUMN "colorKey" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT,
ADD COLUMN "variantColor" TEXT,
ADD COLUMN "variantSize" TEXT;

-- AlterTable
ALTER TABLE "InventoryLedger" ADD COLUMN "variantId" TEXT;

-- CreateIndex
CREATE INDEX "ProductVariant_productId_enabled_idx" ON "ProductVariant"("productId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_color_size_key" ON "ProductVariant"("productId", "color", "size");

-- CreateIndex
CREATE INDEX "ProductImage_variantId_idx" ON "ProductImage"("variantId");

-- CreateIndex
CREATE INDEX "ProductImage_productId_colorKey_idx" ON "ProductImage"("productId", "colorKey");

-- CreateIndex
CREATE INDEX "OrderItem_variantId_idx" ON "OrderItem"("variantId");

-- CreateIndex
CREATE INDEX "InventoryLedger_variantId_createdAt_idx" ON "InventoryLedger"("variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
