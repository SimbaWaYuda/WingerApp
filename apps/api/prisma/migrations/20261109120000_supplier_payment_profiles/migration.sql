-- CreateEnum
CREATE TYPE "PaymentArrangementPreference" AS ENUM ('WINGER_MANAGED', 'SUPPLIER_DIRECT');

-- CreateEnum
CREATE TYPE "SupplierPaymentProfileStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "MobileMoneyNetwork" AS ENUM ('ALL_NETWORKS', 'M_PESA', 'TIGO', 'AIRTEL', 'HALO', 'OTHER');

-- CreateTable
CREATE TABLE "SupplierPaymentProfile" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "preference" "PaymentArrangementPreference" NOT NULL DEFAULT 'WINGER_MANAGED',
    "network" "MobileMoneyNetwork" NOT NULL DEFAULT 'ALL_NETWORKS',
    "merchantName" TEXT NOT NULL,
    "lipaOrTillNumber" TEXT NOT NULL,
    "businessRegRef" TEXT,
    "tinRef" TEXT,
    "notes" TEXT,
    "status" "SupplierPaymentProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "submittedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewNote" TEXT,
    "activeFrom" TIMESTAMP(3),
    "replacesProfileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierPaymentProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPaymentProfile_replacesProfileId_key" ON "SupplierPaymentProfile"("replacesProfileId");

-- CreateIndex
CREATE INDEX "SupplierPaymentProfile_supplierId_status_idx" ON "SupplierPaymentProfile"("supplierId", "status");

-- CreateIndex
CREATE INDEX "SupplierPaymentProfile_status_submittedAt_idx" ON "SupplierPaymentProfile"("status", "submittedAt");

-- AddForeignKey
ALTER TABLE "SupplierPaymentProfile" ADD CONSTRAINT "SupplierPaymentProfile_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentProfile" ADD CONSTRAINT "SupplierPaymentProfile_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentProfile" ADD CONSTRAINT "SupplierPaymentProfile_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentProfile" ADD CONSTRAINT "SupplierPaymentProfile_replacesProfileId_fkey" FOREIGN KEY ("replacesProfileId") REFERENCES "SupplierPaymentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
