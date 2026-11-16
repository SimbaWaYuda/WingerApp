-- S2.6.20.1 — Additive lease fields for future PENDING card payment reconciliation.
-- No payment-status or stock backfill. Defaults keep existing rows eligible only when due.

ALTER TABLE "Order" ADD COLUMN "paymentReconcileLeaseOwner" TEXT;
ALTER TABLE "Order" ADD COLUMN "paymentReconcileLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paymentReconcileAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "paymentReconcileNextAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "paymentReconcileManualReviewAt" TIMESTAMP(3);

-- Supports PENDING eligibility scans ordered by next-attempt / charge-attempt age.
CREATE INDEX "Order_paymentStatus_paymentReconcileNextAt_stripeChargeAttemptAt_idx"
  ON "Order"("paymentStatus", "paymentReconcileNextAt", "stripeChargeAttemptAt");
