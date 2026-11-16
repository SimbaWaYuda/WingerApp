-- S2.6.20.5a — Additive manual-review reason for unleaseable PENDING card escalation.
-- No backfill. Existing rows keep NULL reason.

CREATE TYPE "PaymentReconcileManualReviewReason" AS ENUM (
  'MISSING_ATTEMPT_AT',
  'INCONSISTENT_ATTEMPT_AT',
  'RETRY_EXHAUSTED',
  'SEARCH_AMBIGUOUS',
  'SEARCH_UNRESOLVED'
);

ALTER TABLE "Order"
  ADD COLUMN "paymentReconcileManualReviewReason" "PaymentReconcileManualReviewReason";
