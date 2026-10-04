-- CreateEnum
CREATE TYPE "CommissionRecognitionStatus" AS ENUM ('PENDING', 'RECOGNIZED', 'SETTLEABLE');

-- CreateEnum
CREATE TYPE "CommissionAgreementStatus" AS ENUM ('PROPOSED', 'COUNTERED', 'APPROVED', 'ACTIVE', 'REJECTED', 'SUPERSEDED');

-- AlterTable PlatformSettings
ALTER TABLE "PlatformSettings" ADD COLUMN "defaultCommissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 10;

-- AlterTable Order
ALTER TABLE "Order" ADD COLUMN "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "deliveryFee" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable SupplierCommissionAgreement
CREATE TABLE "SupplierCommissionAgreement" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "proposedRatePercent" DECIMAL(5,2) NOT NULL,
    "counterRatePercent" DECIMAL(5,2),
    "effectiveRatePercent" DECIMAL(5,2),
    "status" "CommissionAgreementStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedByRole" "UserRole" NOT NULL,
    "proposedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "acceptedByUserId" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCommissionAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorRole" "UserRole" NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable OrderItemCommission
CREATE TABLE "OrderItemCommission" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "agreementId" TEXT,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "commissionBase" DECIMAL(12,2) NOT NULL,
    "commissionAmount" DECIMAL(12,2) NOT NULL,
    "status" "CommissionRecognitionStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMode" TEXT NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "recognizedAt" TIMESTAMP(3),
    "settleableAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItemCommission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemCommission_orderItemId_key" ON "OrderItemCommission"("orderItemId");
CREATE INDEX "OrderItemCommission_status_idx" ON "OrderItemCommission"("status");
CREATE INDEX "OrderItemCommission_agreementId_idx" ON "OrderItemCommission"("agreementId");
CREATE INDEX "SupplierCommissionAgreement_supplierId_status_idx" ON "SupplierCommissionAgreement"("supplierId", "status");
CREATE INDEX "SupplierCommissionAgreement_supplierId_effectiveFrom_idx" ON "SupplierCommissionAgreement"("supplierId", "effectiveFrom");
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "SupplierCommissionAgreement" ADD CONSTRAINT "SupplierCommissionAgreement_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierCommissionAgreement" ADD CONSTRAINT "SupplierCommissionAgreement_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierCommissionAgreement" ADD CONSTRAINT "SupplierCommissionAgreement_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SupplierCommissionAgreement" ADD CONSTRAINT "SupplierCommissionAgreement_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItemCommission" ADD CONSTRAINT "OrderItemCommission_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderItemCommission" ADD CONSTRAINT "OrderItemCommission_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "SupplierCommissionAgreement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
