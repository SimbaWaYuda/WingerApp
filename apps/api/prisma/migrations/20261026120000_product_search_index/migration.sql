-- AlterTable
ALTER TABLE "Product" ADD COLUMN "searchText" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "ProductSearchEmbedding" (
    "productId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vector" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSearchEmbedding_pkey" PRIMARY KEY ("productId")
);

-- AddForeignKey
ALTER TABLE "ProductSearchEmbedding" ADD CONSTRAINT "ProductSearchEmbedding_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
