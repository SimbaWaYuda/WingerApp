-- Phase 3 Stage 1: RefundAttempt + RefundAttemptSubmission (Option B).
-- Additive only. No existing return, cancel, commission, COD, or Lipa rows are rewritten.
-- This migration is prepared only — apply separately when authorised.
--
-- Order FK: ON DELETE RESTRICT (refund history must survive order hard-delete attempts).
-- Submission FK: ON DELETE RESTRICT (submission rows are not wiped if an attempt is deleted).
--
-- Idempotency (Stage 2+):
--   operationKey = logical operation (unique on RefundAttempt).
--   Each Stripe submit version = one RefundAttemptSubmission row (append-only history).
--   Retry = same submission row + same stripeIdempotencyKey.
--   SUBMISSION_UNKNOWN = reconcile before any new version INSERT.
--   New version only after prior reconciliationResult = NO_MATCH (never on timeout).
--   Concurrency: lock RefundAttempt FOR UPDATE, INSERT version+1;
--   UNIQUE(refundAttemptId, version) and UNIQUE(stripeIdempotencyKey) reject races.

CREATE TYPE "RefundAttemptStatus" AS ENUM (
  'PENDING',
  'SUBMISSION_UNKNOWN',
  'STRIPE_SUCCEEDED',
  'STRIPE_FAILED',
  'APPLY_FAILED',
  'APPLIED',
  'NEEDS_INVESTIGATION',
  'PERMANENTLY_FAILED',
  'SUPERSEDED'
);

CREATE TYPE "RefundAttemptKind" AS ENUM (
  'RETURN',
  'ORDER_CANCEL',
  'LINE_CANCEL',
  'CANCEL_REMAINING',
  'UNSELLABLE'
);

CREATE TYPE "TransferReversalStatus" AS ENUM (
  'NOT_REQUIRED',
  'PENDING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'SUBMISSION_UNKNOWN',
  'BLOCKED_LIVE',
  'OUTSTANDING',
  'SKIPPED_PARTIAL',
  'WRITTEN_OFF'
);

CREATE TYPE "RefundReconciliationResult" AS ENUM (
  'NONE',
  'MATCHED',
  'NO_MATCH',
  'AMBIGUOUS',
  'UNVERIFIED_LEGACY'
);

CREATE TYPE "RefundSubmissionOutcome" AS ENUM (
  'PENDING',
  'SUBMISSION_UNKNOWN',
  'SUCCEEDED',
  'FAILED',
  'SUPERSEDED_BY_NO_MATCH'
);

CREATE TABLE "RefundAttempt" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" "RefundAttemptKind" NOT NULL,
    "status" "RefundAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "orderId" TEXT NOT NULL,
    "returnRequestId" TEXT,
    "orderItemId" TEXT,
    "orderShipmentId" TEXT,
    "supplierId" TEXT,
    "actorUserId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeRefundId" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "includeDelivery" BOOLEAN NOT NULL DEFAULT false,
    "shipmentRefundApplied" BOOLEAN NOT NULL DEFAULT false,
    "clawbackAppliedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "applyError" TEXT,
    "transferReversalStatus" "TransferReversalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "transferId" TEXT,
    "transferReversalId" TEXT,
    "transferReversalIdempotencyKey" TEXT,
    "transferSubmittedAt" TIMESTAMP(3),
    "originalTransferAmount" DECIMAL(12,2),
    "originalMerchandiseBasis" DECIMAL(12,2),
    "returnedMerchandise" DECIMAL(12,2),
    "reversedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unrecoveredAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unrecoveredCurrency" TEXT,
    "unrecoveredCalcJson" JSONB,
    "connectOverrideAuditId" TEXT,
    "writeOffAuditId" TEXT,
    "writeOffAt" TIMESTAMP(3),
    "investigationReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefundAttemptSubmission" (
    "id" TEXT NOT NULL,
    "refundAttemptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "stripeIdempotencyKey" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reconciliationResult" "RefundReconciliationResult" NOT NULL DEFAULT 'NONE',
    "stripeRefundId" TEXT,
    "outcome" "RefundSubmissionOutcome" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundAttemptSubmission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefundAttempt_operationKey_key" ON "RefundAttempt"("operationKey");
CREATE UNIQUE INDEX "RefundAttempt_stripeRefundId_key" ON "RefundAttempt"("stripeRefundId");

CREATE INDEX "RefundAttempt_orderId_idx" ON "RefundAttempt"("orderId");
CREATE INDEX "RefundAttempt_returnRequestId_idx" ON "RefundAttempt"("returnRequestId");
CREATE INDEX "RefundAttempt_orderItemId_idx" ON "RefundAttempt"("orderItemId");
CREATE INDEX "RefundAttempt_orderShipmentId_idx" ON "RefundAttempt"("orderShipmentId");
CREATE INDEX "RefundAttempt_supplierId_idx" ON "RefundAttempt"("supplierId");
CREATE INDEX "RefundAttempt_actorUserId_idx" ON "RefundAttempt"("actorUserId");
CREATE INDEX "RefundAttempt_status_updatedAt_idx" ON "RefundAttempt"("status", "updatedAt");
CREATE INDEX "RefundAttempt_transferReversalStatus_updatedAt_idx" ON "RefundAttempt"("transferReversalStatus", "updatedAt");
CREATE INDEX "RefundAttempt_stripePaymentIntentId_idx" ON "RefundAttempt"("stripePaymentIntentId");

CREATE UNIQUE INDEX "RefundAttemptSubmission_stripeIdempotencyKey_key" ON "RefundAttemptSubmission"("stripeIdempotencyKey");
CREATE UNIQUE INDEX "RefundAttemptSubmission_stripeRefundId_key" ON "RefundAttemptSubmission"("stripeRefundId");
CREATE UNIQUE INDEX "RefundAttemptSubmission_refundAttemptId_version_key" ON "RefundAttemptSubmission"("refundAttemptId", "version");
CREATE INDEX "RefundAttemptSubmission_refundAttemptId_idx" ON "RefundAttemptSubmission"("refundAttemptId");
CREATE INDEX "RefundAttemptSubmission_outcome_updatedAt_idx" ON "RefundAttemptSubmission"("outcome", "updatedAt");

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_orderItemId_fkey"
  FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_orderShipmentId_fkey"
  FOREIGN KEY ("orderShipmentId") REFERENCES "OrderShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RefundAttempt"
  ADD CONSTRAINT "RefundAttempt_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RefundAttemptSubmission"
  ADD CONSTRAINT "RefundAttemptSubmission_refundAttemptId_fkey"
  FOREIGN KEY ("refundAttemptId") REFERENCES "RefundAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
