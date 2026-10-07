-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "replacesOrderItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_replacesOrderItemId_key" ON "OrderItem"("replacesOrderItemId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_replacesOrderItemId_fkey" FOREIGN KEY ("replacesOrderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
