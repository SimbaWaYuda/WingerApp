/**
 * Pure Stripe refund fingerprint matching for RefundAttempt S2.1 reconcile.
 * Never classifies incomplete lists — callers must pass exhausted pagination only.
 */

export type RefundFingerprint = {
  orderId: string;
  operationKey: string;
  amountCents: number;
  currency: string;
  returnRequestId?: string | null;
};

export type MatchableStripeRefund = {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
  failureReason?: string | null;
  metadata: Record<string, string>;
};

export const LIVE_REFUND_STATUSES = new Set([
  'succeeded',
  'pending',
  'requires_action',
]);

export const FAILED_REFUND_STATUSES = new Set(['failed', 'canceled']);

export type ReconciliationClassification =
  | { kind: 'MATCHED_LIVE'; refund: MatchableStripeRefund }
  | { kind: 'MATCHED_FAILED'; refund: MatchableStripeRefund }
  | { kind: 'NO_MATCH' }
  | { kind: 'AMBIGUOUS'; reason: string };

export function isLiveRefundStatus(status: string | null | undefined): boolean {
  return LIVE_REFUND_STATUSES.has((status ?? '').toLowerCase());
}

export function isFailedRefundStatus(status: string | null | undefined): boolean {
  return FAILED_REFUND_STATUSES.has((status ?? '').toLowerCase());
}

/** Stripe object status that means customer settlement is confirmed. */
export function isSucceededRefundStatus(
  status: string | null | undefined,
): boolean {
  return (status ?? '').toLowerCase() === 'succeeded';
}

export function isExactFingerprintMatch(
  refund: MatchableStripeRefund,
  fingerprint: RefundFingerprint,
): boolean {
  if (refund.amount !== fingerprint.amountCents) return false;
  if (refund.currency.toLowerCase() !== fingerprint.currency.toLowerCase()) {
    return false;
  }
  if (refund.metadata.orderId !== fingerprint.orderId) return false;
  if (refund.metadata.operationKey !== fingerprint.operationKey) return false;
  if (fingerprint.returnRequestId) {
    if (refund.metadata.returnRequestId !== fingerprint.returnRequestId) {
      return false;
    }
  }
  return true;
}

/**
 * Amount+currency (+ optional orderId) overlap without a full fingerprint —
 * could still be this operation (legacy/incomplete metadata). Never NO_MATCH.
 */
export function isUncertainPartialMatch(
  refund: MatchableStripeRefund,
  fingerprint: RefundFingerprint,
): boolean {
  if (isExactFingerprintMatch(refund, fingerprint)) return false;
  if (refund.amount !== fingerprint.amountCents) return false;
  if (refund.currency.toLowerCase() !== fingerprint.currency.toLowerCase()) {
    return false;
  }
  const metaOrder = refund.metadata.orderId;
  if (metaOrder && metaOrder !== fingerprint.orderId) return false;
  // Same amount/currency on this PI and metadata does not clearly belong elsewhere.
  const op = refund.metadata.operationKey;
  if (op && op !== fingerprint.operationKey) {
    // Conflicting operationKey with same amount — still uncertain/ambiguous territory.
    return true;
  }
  if (fingerprint.returnRequestId) {
    const rr = refund.metadata.returnRequestId;
    if (rr && rr !== fingerprint.returnRequestId) return true;
    if (!op || !rr) return true;
  } else if (!op) {
    return true;
  }
  return !op;
}

/**
 * Classify an exhausted refund list for one attempt fingerprint.
 * Call only when Stripe pagination completed successfully.
 */
export function classifyRefundReconciliation(
  refunds: MatchableStripeRefund[],
  fingerprint: RefundFingerprint,
): ReconciliationClassification {
  const exact = refunds.filter((r) => isExactFingerprintMatch(r, fingerprint));
  if (exact.length > 1) {
    return { kind: 'AMBIGUOUS', reason: 'ambiguous_multiple_exact' };
  }
  if (exact.length === 1) {
    const refund = exact[0];
    if (isLiveRefundStatus(refund.status)) {
      return { kind: 'MATCHED_LIVE', refund };
    }
    if (isFailedRefundStatus(refund.status)) {
      return { kind: 'MATCHED_FAILED', refund };
    }
    return {
      kind: 'AMBIGUOUS',
      reason: `ambiguous_exact_unknown_status:${refund.status ?? 'null'}`,
    };
  }

  const partials = refunds.filter((r) =>
    isUncertainPartialMatch(r, fingerprint),
  );
  if (partials.length > 0) {
    return { kind: 'AMBIGUOUS', reason: 'ambiguous_partial_or_incomplete_metadata' };
  }

  return { kind: 'NO_MATCH' };
}

/** Sanitize Stripe/error text for lastError / investigationReason (no raw payloads). */
export function sanitizeRefundErrorDetail(input: {
  stripeStatus?: string | null;
  failureReason?: string | null;
  message?: string | null;
  code?: string | null;
  maxLen?: number;
}): string {
  const parts: string[] = [];
  if (input.stripeStatus) parts.push(`stripe_status=${input.stripeStatus}`);
  if (input.code) parts.push(`code=${truncate(input.code, 64)}`);
  if (input.failureReason) {
    parts.push(`failure=${truncate(input.failureReason, 120)}`);
  }
  if (input.message) parts.push(truncate(input.message, 160));
  const joined = parts.join('; ') || 'stripe_error';
  return truncate(joined, input.maxLen ?? 400);
}

function truncate(value: string, max: number): string {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 3)}...`;
}
