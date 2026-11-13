-- Additive reliability for Lipa confirmation, recognition recovery, and system sweep audit.
-- Existing allocation, credit, remittance, and reversal rows are not rewritten.

CREATE TYPE "CommissionActorType" AS ENUM ('USER', 'SYSTEM');
CREATE TYPE "CommissionRecognitionJobStatus" AS ENUM ('PENDING', 'AWAITING_SWEEP', 'COMPLETED');

ALTER TABLE "CommissionAllocation"
  ADD COLUMN "actorType" "CommissionActorType" NOT NULL DEFAULT 'USER',
  ADD COLUMN "systemActorKey" TEXT;

ALTER TABLE "CommissionCreditApplication"
  ADD COLUMN "actorType" "CommissionActorType" NOT NULL DEFAULT 'USER',
  ADD COLUMN "systemActorKey" TEXT;

CREATE TABLE "CommissionRecognitionJob" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "CommissionRecognitionJobStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "CommissionRecognitionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommissionRecognitionJob_orderItemId_key" ON "CommissionRecognitionJob"("orderItemId");
CREATE INDEX "CommissionRecognitionJob_orderId_status_idx" ON "CommissionRecognitionJob"("orderId", "status");
CREATE INDEX "CommissionRecognitionJob_status_createdAt_idx" ON "CommissionRecognitionJob"("status", "createdAt");

CREATE TABLE "CommissionSystemEvent" (
    "id" TEXT NOT NULL,
    "actorType" "CommissionActorType" NOT NULL DEFAULT 'SYSTEM',
    "systemActorKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "supplierId" TEXT,
    "afterJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommissionSystemEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommissionSystemEvent_entityType_entityId_createdAt_idx" ON "CommissionSystemEvent"("entityType", "entityId", "createdAt");
CREATE INDEX "CommissionSystemEvent_supplierId_createdAt_idx" ON "CommissionSystemEvent"("supplierId", "createdAt");
