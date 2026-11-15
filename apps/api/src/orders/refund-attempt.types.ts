/**
 * Stage 2 RefundAttempt helpers (S2.0).
 * Values mirror prisma/schema.prisma enums. Prefer these until the default
 * @prisma/client is regenerated against Option B (RefundAttemptSubmission).
 */

export const REFUND_ATTEMPT_V1_ENV = 'REFUND_ATTEMPT_V1';

export type RefundAttemptKindName =
  | 'RETURN'
  | 'ORDER_CANCEL'
  | 'LINE_CANCEL'
  | 'CANCEL_REMAINING'
  | 'UNSELLABLE';

export type RefundSubmissionOutcomeName =
  | 'PENDING'
  | 'SUBMISSION_UNKNOWN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SUPERSEDED_BY_NO_MATCH';

export type RefundReconciliationResultName =
  | 'NONE'
  | 'MATCHED'
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'UNVERIFIED_LEGACY';

/** Stable logical operation keys — never versioned. */
export function operationKeyForReturn(returnRequestId: string): string {
  return `return:${returnRequestId}`;
}

export function operationKeyForOrderCancel(orderId: string): string {
  return `cancel:${orderId}`;
}

export function operationKeyForLineCancel(orderItemId: string): string {
  return `line-cancel:${orderItemId}`;
}

export function operationKeyForCancelRemaining(orderItemId: string): string {
  return `cancel-remaining:${orderItemId}`;
}

export function operationKeyForUnsellable(orderId: string): string {
  return `unsellable:${orderId}`;
}

/**
 * Stripe Idempotency-Key for one submission version.
 * Retries of the same version must reuse this exact string.
 * Bump version (new string) only after reconciliationResult === NO_MATCH.
 */
export function stripeIdempotencyKeyForSubmission(
  operationKey: string,
  version: number,
): string {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Submission version must be a positive integer');
  }
  return `winger-ra:${operationKey}:v${version}`;
}

export type LatestSubmissionView = {
  version: number;
  outcome: RefundSubmissionOutcomeName;
  reconciliationResult: RefundReconciliationResultName;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
};

/**
 * Whether a new RefundAttemptSubmission row (version+1) may be inserted.
 * SUBMISSION_UNKNOWN / AMBIGUOUS / MATCHED / SUCCEEDED never allow a new version
 * without going through reconcile first (and only NO_MATCH opens a new version).
 */
export function canInsertNextSubmissionVersion(
  latest: LatestSubmissionView | null,
): { allowed: boolean; reason: string } {
  if (!latest) {
    return { allowed: true, reason: 'no_prior_submission' };
  }
  if (latest.outcome === 'SUBMISSION_UNKNOWN') {
    return {
      allowed: false,
      reason: 'submission_unknown_requires_reconcile',
    };
  }
  if (latest.reconciliationResult === 'AMBIGUOUS') {
    return { allowed: false, reason: 'ambiguous_requires_admin' };
  }
  if (latest.reconciliationResult === 'NO_MATCH') {
    return { allowed: true, reason: 'confirmed_no_match' };
  }
  if (
    latest.outcome === 'PENDING' ||
    latest.outcome === 'SUCCEEDED' ||
    latest.outcome === 'FAILED' ||
    latest.outcome === 'SUPERSEDED_BY_NO_MATCH'
  ) {
    return { allowed: false, reason: 'prior_submission_still_active_or_final' };
  }
  return { allowed: false, reason: 'blocked' };
}

/** Idempotency keys older than this must not be blindly replayed — reconcile first. */
export const STRIPE_IDEMPOTENCY_RETAIN_MS = 24 * 60 * 60 * 1000;

export function requiresReconcileBeforeStripeCreate(input: {
  outcome: RefundSubmissionOutcomeName;
  submittedAt: Date | null;
  now?: Date;
}): boolean {
  if (input.outcome === 'SUBMISSION_UNKNOWN') return true;
  if (!input.submittedAt) return false;
  const now = input.now ?? new Date();
  return (
    now.getTime() - input.submittedAt.getTime() >= STRIPE_IDEMPOTENCY_RETAIN_MS
  );
}

export function isRefundAttemptV1Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[REFUND_ATTEMPT_V1_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
