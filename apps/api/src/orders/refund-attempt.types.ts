/**
 * Stage 2 RefundAttempt helpers (S2.0/S2.1).
 * Values mirror prisma/schema.prisma enums.
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
 * Bump version (new string) only after reconciliationResult === NO_MATCH
 * or confirmed unique failed/canceled object (MATCHED + FAILED).
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
  stripeRefundId?: string | null;
};

/** Idempotency keys older than this must not be blindly replayed — reconcile first. */
export const STRIPE_IDEMPOTENCY_RETAIN_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a new RefundAttemptSubmission row (version+1) may be inserted.
 * SUBMISSION_UNKNOWN / AMBIGUOUS / live MATCHED / SUCCEEDED never allow a new version
 * without going through reconcile first.
 * New version after: reconciliationResult === NO_MATCH, or confirmed failed/canceled
 * object (outcome FAILED + reconciliationResult MATCHED).
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
      reason: isUnresolvedClaimedStripeCreate(latest)
        ? 'unresolved_claimed_stripe_create'
        : 'submission_unknown_requires_reconcile',
    };
  }
  if (isUnresolvedClaimedStripeCreate(latest)) {
    return { allowed: false, reason: 'unresolved_claimed_stripe_create' };
  }
  if (latest.reconciliationResult === 'AMBIGUOUS') {
    return { allowed: false, reason: 'ambiguous_requires_admin' };
  }
  if (latest.reconciliationResult === 'NO_MATCH') {
    return { allowed: true, reason: 'confirmed_no_match' };
  }
  if (
    latest.outcome === 'FAILED' &&
    latest.reconciliationResult === 'MATCHED'
  ) {
    return {
      allowed: true,
      reason: 'confirmed_stripe_refund_failed_or_canceled',
    };
  }
  if (latest.outcome === 'SUCCEEDED') {
    return { allowed: false, reason: 'prior_submission_succeeded' };
  }
  if (latest.outcome === 'PENDING') {
    return { allowed: false, reason: 'prior_submission_still_active' };
  }
  if (latest.outcome === 'FAILED') {
    return {
      allowed: false,
      reason: 'failed_requires_reconcile_before_new_version',
    };
  }
  if (latest.outcome === 'SUPERSEDED_BY_NO_MATCH') {
    return { allowed: false, reason: 'prior_submission_still_active_or_final' };
  }
  return { allowed: false, reason: 'blocked' };
}

/**
 * Claimed for Stripe create but no refund id persisted yet (crash / timeout window).
 * Must not be treated as untouched PENDING and must never NO_MATCH → new version alone.
 */
export function isInFlightUncertainSubmission(
  latest: Pick<
    LatestSubmissionView,
    'outcome' | 'submittedAt' | 'stripeRefundId'
  >,
): boolean {
  return (
    latest.outcome === 'PENDING' &&
    latest.submittedAt != null &&
    !latest.stripeRefundId
  );
}

/**
 * A create was claimed (submittedAt set) but no Stripe refund id is known.
 * Includes PENDING in-flight and SUBMISSION_UNKNOWN retained after empty reconcile.
 * Empty Stripe lists must never auto-promote these to NO_MATCH / next version.
 */
export function isUnresolvedClaimedStripeCreate(
  latest: Pick<
    LatestSubmissionView,
    'outcome' | 'submittedAt' | 'stripeRefundId'
  >,
): boolean {
  if (latest.stripeRefundId) return false;
  if (latest.submittedAt == null) return false;
  return (
    latest.outcome === 'PENDING' || latest.outcome === 'SUBMISSION_UNKNOWN'
  );
}

/** Attempt.investigationReason written when empty reconcile cannot clear an in-flight create. */
export const INFLIGHT_UNRESOLVED_REASON = 'inflight_unresolved_after_reconcile';

/**
 * Whether this submission version may call refunds.create again (same key).
 * Pending/requires_action with a known refund id must not create again.
 * In-flight (PENDING+submittedAt+no id): same-key recovery only inside the 24h window.
 */
export function canRetryStripeCreateSameVersion(
  latest: LatestSubmissionView,
  now: Date = new Date(),
): { allowed: boolean; reason: string } {
  if (latest.outcome === 'SUCCEEDED') {
    return { allowed: false, reason: 'already_succeeded' };
  }
  if (latest.outcome === 'SUBMISSION_UNKNOWN') {
    return { allowed: false, reason: 'submission_unknown_requires_reconcile' };
  }
  if (latest.reconciliationResult === 'AMBIGUOUS') {
    return { allowed: false, reason: 'ambiguous_requires_admin' };
  }
  if (latest.stripeRefundId) {
    return {
      allowed: false,
      reason: 'stripe_refund_object_already_known_for_version',
    };
  }
  if (latest.outcome === 'FAILED') {
    return {
      allowed: false,
      reason: 'failed_object_requires_new_version_after_gate',
    };
  }
  if (isInFlightUncertainSubmission(latest)) {
    const age = now.getTime() - (latest.submittedAt as Date).getTime();
    if (age >= STRIPE_IDEMPOTENCY_RETAIN_MS) {
      return {
        allowed: false,
        reason: 'inflight_outside_idempotency_window',
      };
    }
    return { allowed: true, reason: 'inflight_same_key_recovery' };
  }
  if (latest.outcome === 'PENDING') {
    return { allowed: true, reason: 'pending_without_stripe_id' };
  }
  return { allowed: false, reason: 'blocked' };
}

export function requiresReconcileBeforeStripeCreate(input: {
  outcome: RefundSubmissionOutcomeName;
  submittedAt: Date | null;
  stripeRefundId?: string | null;
  now?: Date;
}): boolean {
  if (input.outcome === 'SUBMISSION_UNKNOWN') return true;
  if (
    isInFlightUncertainSubmission({
      outcome: input.outcome,
      submittedAt: input.submittedAt,
      stripeRefundId: input.stripeRefundId,
    })
  ) {
    // Prefer reconcile for aged in-flight; within-window same-key recovery may proceed.
    const now = input.now ?? new Date();
    return (
      now.getTime() - (input.submittedAt as Date).getTime() >=
      STRIPE_IDEMPOTENCY_RETAIN_MS
    );
  }
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

/**
 * S2.2 must only apply when this is true — never on pending/requires_action/failed,
 * investigation, or when more than one submission version succeeded at Stripe.
 */
export function isApplyEligibleStripeSuccess(input: {
  attemptStatus: string;
  submissionOutcome: RefundSubmissionOutcomeName;
  submissionStripeRefundId: string | null | undefined;
  succeededSubmissionCount?: number;
}): boolean {
  if (input.attemptStatus !== 'STRIPE_SUCCEEDED') return false;
  if (input.submissionOutcome !== 'SUCCEEDED') return false;
  if (!input.submissionStripeRefundId) return false;
  if (
    input.succeededSubmissionCount != null &&
    input.succeededSubmissionCount !== 1
  ) {
    return false;
  }
  return true;
}
