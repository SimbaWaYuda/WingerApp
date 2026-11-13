-- Additive commission collection ledger. Existing commission rows are not updated.

ALTER TABLE "PlatformSettings" ADD COLUMN "wingerLipaNumber" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN "wingerLipaNetwork" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN "wingerBankName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN "wingerBankAccountName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PlatformSettings" ADD COLUMN "wingerBankAccountNumber" TEXT NOT NULL DEFAULT '';

CREATE TYPE "CommissionRemittanceMethod" AS ENUM ('WINGER_LIPA', 'BANK_TRANSFER', 'ADMIN_RECORDED');
CREATE TYPE "CommissionRemittanceStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'REVERSED');
CREATE TYPE "CommissionEvidenceStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED');
CREATE TYPE "CommissionAllocationReason" AS ENUM ('AUTO', 'MANUAL', 'SWEEP');
CREATE TYPE "CommissionCreditReason" AS ENUM ('CLAWBACK_AFTER_COLLECTION');
CREATE TYPE "CommissionCreditApplicationReason" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "CommissionApplicationReversalReason" AS ENUM ('CUSTOMER_REFUND', 'REMITTANCE_REVERSED', 'MANUAL');

CREATE TABLE "CommissionRemittance" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "method" "CommissionRemittanceMethod" NOT NULL,
    "status" "CommissionRemittanceStatus" NOT NULL DEFAULT 'SUBMITTED',
    "claimedAmount" DECIMAL(12,2) NOT NULL,
    "claimedCurrency" TEXT NOT NULL,
    "verifiedAmountUsd" DECIMAL(12,2),
    "fxBaseCurrency" TEXT,
    "fxQuoteCurrency" TEXT,
    "fxRate" DECIMAL(18,8),
    "fxSource" TEXT,
    "fxFetchedAt" TIMESTAMP(3),
    "fxExpiresAt" TIMESTAMP(3),
    "referenceRaw" TEXT NOT NULL,
    "referenceNormalized" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "merchantAccountKey" TEXT NOT NULL,
    "proofStorageKey" TEXT,
    "autoApply" BOOLEAN NOT NULL DEFAULT true,
    "supplierNote" TEXT,
    "reviewNote" TEXT,
    "submittedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommissionRemittance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionPaymentReference" (
    "id" TEXT NOT NULL,
    "remittanceId" TEXT NOT NULL,
    "method" "CommissionRemittanceMethod" NOT NULL,
    "provider" TEXT NOT NULL,
    "merchantAccountKey" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "referenceNormalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionPaymentReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionAllocation" (
    "id" TEXT NOT NULL,
    "remittanceId" TEXT NOT NULL,
    "orderItemCommissionId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" "CommissionAllocationReason" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionRemittanceReversal" (
    "id" TEXT NOT NULL,
    "remittanceId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "originalReference" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionRemittanceReversal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionAllocationReversal" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "remittanceReversalId" TEXT,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "reversalKey" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionAllocationReversal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionProviderEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "remittanceReversalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionProviderEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCredit" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "orderItemCommissionId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" "CommissionCreditReason" NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCredit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditSource" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCreditSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditApplication" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "orderItemCommissionId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" "CommissionCreditApplicationReason" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCreditApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditApplicationSource" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "creditSourceId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCreditApplicationSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditApplicationSourceReversal" (
    "id" TEXT NOT NULL,
    "applicationSourceId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" "CommissionApplicationReversalReason" NOT NULL,
    "reversalKey" TEXT NOT NULL,
    "remittanceReversalId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCreditApplicationSourceReversal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditOffset" (
    "id" TEXT NOT NULL,
    "creditId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "remittanceReversalId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionCreditOffset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CommissionCreditOffsetSource" (
    "id" TEXT NOT NULL,
    "offsetId" TEXT NOT NULL,
    "creditSourceId" TEXT NOT NULL,
    "amountUsd" DECIMAL(12,2) NOT NULL,
    CONSTRAINT "CommissionCreditOffsetSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerPaymentEvidence" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "referenceRaw" TEXT NOT NULL,
    "referenceNormalized" TEXT NOT NULL,
    "proofStorageKey" TEXT,
    "note" TEXT,
    "status" "CommissionEvidenceStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedByUserId" TEXT NOT NULL,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomerPaymentEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerPaymentEvidenceOpen" (
    "orderId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    CONSTRAINT "CustomerPaymentEvidenceOpen_pkey" PRIMARY KEY ("orderId","supplierId")
);

CREATE UNIQUE INDEX "CommissionPaymentReference_remittanceId_key" ON "CommissionPaymentReference"("remittanceId");
CREATE UNIQUE INDEX "CommissionPaymentReference_method_provider_merchantAccountKey_currency_referenceNormalized_key" ON "CommissionPaymentReference"("method", "provider", "merchantAccountKey", "currency", "referenceNormalized");
CREATE UNIQUE INDEX "CommissionAllocationReversal_reversalKey_key" ON "CommissionAllocationReversal"("reversalKey");
CREATE UNIQUE INDEX "CommissionRemittanceReversal_remittanceId_key" ON "CommissionRemittanceReversal"("remittanceId");
CREATE UNIQUE INDEX "CommissionProviderEvent_eventId_key" ON "CommissionProviderEvent"("eventId");
CREATE UNIQUE INDEX "CommissionProviderEvent_remittanceReversalId_key" ON "CommissionProviderEvent"("remittanceReversalId");
CREATE UNIQUE INDEX "CommissionCredit_sourceEventKey_key" ON "CommissionCredit"("sourceEventKey");
CREATE UNIQUE INDEX "CommissionCreditApplicationSource_applicationId_creditSourceId_key" ON "CommissionCreditApplicationSource"("applicationId", "creditSourceId");
CREATE UNIQUE INDEX "CommissionCreditApplicationSourceReversal_reversalKey_key" ON "CommissionCreditApplicationSourceReversal"("reversalKey");
CREATE UNIQUE INDEX "CommissionCreditOffsetSource_offsetId_creditSourceId_key" ON "CommissionCreditOffsetSource"("offsetId", "creditSourceId");
CREATE UNIQUE INDEX "CustomerPaymentEvidenceOpen_evidenceId_key" ON "CustomerPaymentEvidenceOpen"("evidenceId");

CREATE INDEX "CommissionRemittance_supplierId_status_idx" ON "CommissionRemittance"("supplierId", "status");
CREATE INDEX "CommissionRemittance_status_createdAt_idx" ON "CommissionRemittance"("status", "createdAt");
CREATE INDEX "CommissionAllocation_remittanceId_idx" ON "CommissionAllocation"("remittanceId");
CREATE INDEX "CommissionAllocation_orderItemCommissionId_idx" ON "CommissionAllocation"("orderItemCommissionId");
CREATE INDEX "CommissionAllocationReversal_allocationId_idx" ON "CommissionAllocationReversal"("allocationId");
CREATE INDEX "CommissionRemittanceReversal_createdAt_idx" ON "CommissionRemittanceReversal"("createdAt");
CREATE INDEX "CommissionCredit_supplierId_idx" ON "CommissionCredit"("supplierId");
CREATE INDEX "CommissionCredit_orderItemCommissionId_idx" ON "CommissionCredit"("orderItemCommissionId");
CREATE INDEX "CommissionCreditSource_creditId_createdAt_idx" ON "CommissionCreditSource"("creditId", "createdAt");
CREATE INDEX "CommissionCreditSource_allocationId_idx" ON "CommissionCreditSource"("allocationId");
CREATE INDEX "CommissionCreditApplication_creditId_idx" ON "CommissionCreditApplication"("creditId");
CREATE INDEX "CommissionCreditApplication_orderItemCommissionId_idx" ON "CommissionCreditApplication"("orderItemCommissionId");
CREATE INDEX "CommissionCreditApplicationSource_creditSourceId_idx" ON "CommissionCreditApplicationSource"("creditSourceId");
CREATE INDEX "CommissionCreditApplicationSourceReversal_applicationSourceId_idx" ON "CommissionCreditApplicationSourceReversal"("applicationSourceId");
CREATE INDEX "CommissionCreditOffset_creditId_idx" ON "CommissionCreditOffset"("creditId");
CREATE INDEX "CommissionCreditOffset_remittanceReversalId_idx" ON "CommissionCreditOffset"("remittanceReversalId");
CREATE INDEX "CommissionCreditOffsetSource_creditSourceId_idx" ON "CommissionCreditOffsetSource"("creditSourceId");
CREATE INDEX "CustomerPaymentEvidence_supplierId_status_idx" ON "CustomerPaymentEvidence"("supplierId", "status");
CREATE INDEX "CustomerPaymentEvidence_orderId_idx" ON "CustomerPaymentEvidence"("orderId");

ALTER TABLE "CommissionRemittance" ADD CONSTRAINT "CommissionRemittance_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionRemittance" ADD CONSTRAINT "CommissionRemittance_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionRemittance" ADD CONSTRAINT "CommissionRemittance_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionPaymentReference" ADD CONSTRAINT "CommissionPaymentReference_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CommissionRemittance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommissionAllocation" ADD CONSTRAINT "CommissionAllocation_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CommissionRemittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAllocation" ADD CONSTRAINT "CommissionAllocation_orderItemCommissionId_fkey" FOREIGN KEY ("orderItemCommissionId") REFERENCES "OrderItemCommission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionRemittanceReversal" ADD CONSTRAINT "CommissionRemittanceReversal_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CommissionRemittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionRemittanceReversal" ADD CONSTRAINT "CommissionRemittanceReversal_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAllocationReversal" ADD CONSTRAINT "CommissionAllocationReversal_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "CommissionAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAllocationReversal" ADD CONSTRAINT "CommissionAllocationReversal_remittanceReversalId_fkey" FOREIGN KEY ("remittanceReversalId") REFERENCES "CommissionRemittanceReversal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionProviderEvent" ADD CONSTRAINT "CommissionProviderEvent_remittanceReversalId_fkey" FOREIGN KEY ("remittanceReversalId") REFERENCES "CommissionRemittanceReversal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionCredit" ADD CONSTRAINT "CommissionCredit_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCredit" ADD CONSTRAINT "CommissionCredit_orderItemCommissionId_fkey" FOREIGN KEY ("orderItemCommissionId") REFERENCES "OrderItemCommission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditSource" ADD CONSTRAINT "CommissionCreditSource_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "CommissionCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditSource" ADD CONSTRAINT "CommissionCreditSource_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "CommissionAllocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditApplication" ADD CONSTRAINT "CommissionCreditApplication_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "CommissionCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditApplication" ADD CONSTRAINT "CommissionCreditApplication_orderItemCommissionId_fkey" FOREIGN KEY ("orderItemCommissionId") REFERENCES "OrderItemCommission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditApplicationSource" ADD CONSTRAINT "CommissionCreditApplicationSource_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "CommissionCreditApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditApplicationSource" ADD CONSTRAINT "CommissionCreditApplicationSource_creditSourceId_fkey" FOREIGN KEY ("creditSourceId") REFERENCES "CommissionCreditSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditApplicationSourceReversal" ADD CONSTRAINT "CommissionCreditApplicationSourceReversal_applicationSourceId_fkey" FOREIGN KEY ("applicationSourceId") REFERENCES "CommissionCreditApplicationSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditOffset" ADD CONSTRAINT "CommissionCreditOffset_creditId_fkey" FOREIGN KEY ("creditId") REFERENCES "CommissionCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditOffset" ADD CONSTRAINT "CommissionCreditOffset_remittanceReversalId_fkey" FOREIGN KEY ("remittanceReversalId") REFERENCES "CommissionRemittanceReversal"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditOffsetSource" ADD CONSTRAINT "CommissionCreditOffsetSource_offsetId_fkey" FOREIGN KEY ("offsetId") REFERENCES "CommissionCreditOffset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionCreditOffsetSource" ADD CONSTRAINT "CommissionCreditOffsetSource_creditSourceId_fkey" FOREIGN KEY ("creditSourceId") REFERENCES "CommissionCreditSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPaymentEvidence" ADD CONSTRAINT "CustomerPaymentEvidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPaymentEvidence" ADD CONSTRAINT "CustomerPaymentEvidence_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPaymentEvidence" ADD CONSTRAINT "CustomerPaymentEvidence_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerPaymentEvidence" ADD CONSTRAINT "CustomerPaymentEvidence_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CustomerPaymentEvidenceOpen" ADD CONSTRAINT "CustomerPaymentEvidenceOpen_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "CustomerPaymentEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CommissionPaymentReference" ADD CONSTRAINT "CommissionPaymentReference_provider_nonempty" CHECK (char_length("provider") > 0);
ALTER TABLE "CommissionPaymentReference" ADD CONSTRAINT "CommissionPaymentReference_account_nonempty" CHECK (char_length("merchantAccountKey") > 0);
ALTER TABLE "CommissionPaymentReference" ADD CONSTRAINT "CommissionPaymentReference_currency_nonempty" CHECK (char_length("currency") > 0);
ALTER TABLE "CommissionPaymentReference" ADD CONSTRAINT "CommissionPaymentReference_reference_nonempty" CHECK (char_length("referenceNormalized") > 0);
ALTER TABLE "CommissionProviderEvent" ADD CONSTRAINT "CommissionProviderEvent_event_nonempty" CHECK (char_length("eventId") > 0);
