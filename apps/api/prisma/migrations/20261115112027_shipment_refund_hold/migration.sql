-- Phase 3 S2.3: ReturnRefundDrive + ShipmentRefundHold + LegacyStripeOutcome.
-- Additive only. No historical ReturnRequest rows are backfilled.
-- Existing ISSUED returns remain completed even when refundDrive stays UNCLAIMED.
-- This migration is prepared only — apply separately when authorised.

CREATE TYPE "ReturnRefundDrive" AS ENUM (
  'UNCLAIMED',
  'LEGACY',
  'ATTEMPT'
);

CREATE TYPE "ShipmentRefundHoldStatus" AS ENUM (
  'RESERVED',
  'CONSUMED',
  'RELEASED'
);

CREATE TYPE "LegacyStripeOutcome" AS ENUM (
  'SUCCESS_PENDING_FINALIZE',
  'FAILED_TERMINAL'
);

CREATE TYPE "LegacyStripeEvidenceSource" AS ENUM (
  'FRESH_CREATE',
  'RECOVERY_LIST'
);

CREATE TYPE "LegacyStripeEvidenceClassification" AS ENUM (
  'SUCCEEDED',
  'PENDING',
  'REQUIRES_ACTION',
  'FAILED',
  'CANCELED',
  'UNKNOWN',
  'UNRESOLVED_ERROR',
  'LATE_SUCCESS_AFTER_RELEASED'
);

ALTER TABLE "ReturnRequest"
  ADD COLUMN "refundDrive" "ReturnRefundDrive" NOT NULL DEFAULT 'UNCLAIMED',
  ADD COLUMN "refundAbandonRequestedAt" TIMESTAMP(3);

CREATE INDEX "ReturnRequest_refundDrive_idx" ON "ReturnRequest"("refundDrive");

CREATE TABLE "ShipmentRefundHold" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "orderShipmentId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "returnedMerchandise" DECIMAL(12,2) NOT NULL,
    "includeDelivery" BOOLEAN NOT NULL,
    "proofJson" JSONB NOT NULL,
    "status" "ShipmentRefundHoldStatus" NOT NULL DEFAULT 'RESERVED',
    "refundAttemptId" TEXT,
    "legacyStripeClaimedAt" TIMESTAMP(3),
    "legacyStripeOutcome" "LegacyStripeOutcome",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipmentRefundHold_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShipmentRefundHold_returnRequestId_key"
  ON "ShipmentRefundHold"("returnRequestId");

CREATE UNIQUE INDEX "ShipmentRefundHold_refundAttemptId_key"
  ON "ShipmentRefundHold"("refundAttemptId");

CREATE INDEX "ShipmentRefundHold_orderShipmentId_status_idx"
  ON "ShipmentRefundHold"("orderShipmentId", "status");

CREATE INDEX "ShipmentRefundHold_supplierId_idx"
  ON "ShipmentRefundHold"("supplierId");

ALTER TABLE "ShipmentRefundHold"
  ADD CONSTRAINT "ShipmentRefundHold_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentRefundHold"
  ADD CONSTRAINT "ShipmentRefundHold_orderShipmentId_fkey"
  FOREIGN KEY ("orderShipmentId") REFERENCES "OrderShipment"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentRefundHold"
  ADD CONSTRAINT "ShipmentRefundHold_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentRefundHold"
  ADD CONSTRAINT "ShipmentRefundHold_refundAttemptId_fkey"
  FOREIGN KEY ("refundAttemptId") REFERENCES "RefundAttempt"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Append-only LEGACY Stripe evidence (immutable proofJson stays on the hold).
CREATE TABLE "ShipmentRefundHoldLegacyEvidence" (
    "id" TEXT NOT NULL,
    "shipmentRefundHoldId" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "stripeStatus" TEXT,
    "source" "LegacyStripeEvidenceSource" NOT NULL,
    "classification" "LegacyStripeEvidenceClassification" NOT NULL,
    "message" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentRefundHoldLegacyEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShipmentRefundHoldLegacyEvidence_shipmentRefundHoldId_observedAt_idx"
  ON "ShipmentRefundHoldLegacyEvidence"("shipmentRefundHoldId", "observedAt");

CREATE INDEX "ShipmentRefundHoldLegacyEvidence_returnRequestId_observedAt_idx"
  ON "ShipmentRefundHoldLegacyEvidence"("returnRequestId", "observedAt");

CREATE INDEX "ShipmentRefundHoldLegacyEvidence_stripePaymentIntentId_idx"
  ON "ShipmentRefundHoldLegacyEvidence"("stripePaymentIntentId");

ALTER TABLE "ShipmentRefundHoldLegacyEvidence"
  ADD CONSTRAINT "ShipmentRefundHoldLegacyEvidence_shipmentRefundHoldId_fkey"
  FOREIGN KEY ("shipmentRefundHoldId") REFERENCES "ShipmentRefundHold"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentRefundHoldLegacyEvidence"
  ADD CONSTRAINT "ShipmentRefundHoldLegacyEvidence_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
