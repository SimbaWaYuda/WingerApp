-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK');

-- CreateEnum
CREATE TYPE "SyncEventStatus" AS ENUM ('SUCCESS', 'CONFLICT', 'DUPLICATE');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "previousPrice" DECIMAL(12,2),
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 4.5,
    "imageUrl" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'Standard',
    "color" TEXT NOT NULL DEFAULT 'Default',
    "size" TEXT NOT NULL DEFAULT 'Standard',
    "battery" TEXT NOT NULL DEFAULT '—',
    "weight" TEXT NOT NULL DEFAULT '—',
    "description" TEXT NOT NULL DEFAULT '',
    "stock" INTEGER NOT NULL DEFAULT 0,
    "stockStatus" "StockStatus" NOT NULL DEFAULT 'IN_STOCK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLedger" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "deviceId" TEXT,
    "userId" TEXT,
    "quantityAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncEvent" (
    "eventId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,
    "businessId" TEXT,
    "operation" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" "SyncEventStatus" NOT NULL,
    "message" TEXT,
    "clientTs" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE INDEX "Product_supplierId_idx" ON "Product"("supplierId");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_name_idx" ON "Product"("name");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedger_eventId_key" ON "InventoryLedger"("eventId");

-- CreateIndex
CREATE INDEX "InventoryLedger_productId_createdAt_idx" ON "InventoryLedger"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_supplierId_idx" ON "InventoryLedger"("supplierId");

-- CreateIndex
CREATE INDEX "SyncEvent_operation_receivedAt_idx" ON "SyncEvent"("operation", "receivedAt");

-- CreateIndex
CREATE INDEX "SyncEvent_deviceId_idx" ON "SyncEvent"("deviceId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedger" ADD CONSTRAINT "InventoryLedger_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
