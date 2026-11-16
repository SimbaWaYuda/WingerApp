-- First Stripe PaymentIntent create attempt clock for idempotency-window decisions.
-- Nullable: existing and non-card orders stay valid with no invented backfill.
ALTER TABLE "Order" ADD COLUMN "stripeChargeAttemptAt" TIMESTAMP(3);
