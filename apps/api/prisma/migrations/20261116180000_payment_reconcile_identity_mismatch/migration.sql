-- S2.6.20.9 — Additive IDENTITY_MISMATCH reason for bound PaymentIntent reconcile.
-- No backfill. Existing rows keep their current reason (or NULL).

ALTER TYPE "PaymentReconcileManualReviewReason" ADD VALUE IF NOT EXISTS 'IDENTITY_MISMATCH';
