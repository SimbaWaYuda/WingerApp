import {
  canInsertNextSubmissionVersion,
  canRetryStripeCreateSameVersion,
  isApplyEligibleStripeSuccess,
  isInFlightUncertainSubmission,
  isRefundAttemptV1Enabled,
  isUnresolvedClaimedStripeCreate,
  operationKeyForCancelRemaining,
  operationKeyForLineCancel,
  operationKeyForOrderCancel,
  operationKeyForReturn,
  operationKeyForUnsellable,
  REFUND_ATTEMPT_V1_ENV,
  requiresReconcileBeforeStripeCreate,
  STRIPE_IDEMPOTENCY_RETAIN_MS,
  stripeIdempotencyKeyForSubmission,
} from './refund-attempt.types';

describe('refund-attempt.types', () => {
  describe('operation keys', () => {
    it('builds stable logical keys that are not versioned', () => {
      expect(operationKeyForReturn('ret-1')).toBe('return:ret-1');
      expect(operationKeyForOrderCancel('ord-1')).toBe('cancel:ord-1');
      expect(operationKeyForLineCancel('item-1')).toBe('line-cancel:item-1');
      expect(operationKeyForCancelRemaining('item-2')).toBe(
        'cancel-remaining:item-2',
      );
      expect(operationKeyForUnsellable('ord-9')).toBe('unsellable:ord-9');
    });
  });

  describe('stripeIdempotencyKeyForSubmission', () => {
    it('embeds operationKey and version so retries reuse the same string', () => {
      expect(stripeIdempotencyKeyForSubmission('return:ret-1', 1)).toBe(
        'winger-ra:return:ret-1:v1',
      );
      expect(stripeIdempotencyKeyForSubmission('return:ret-1', 2)).toBe(
        'winger-ra:return:ret-1:v2',
      );
    });

    it('rejects non-positive versions', () => {
      expect(() => stripeIdempotencyKeyForSubmission('return:ret-1', 0)).toThrow(
        /positive integer/,
      );
    });
  });

  describe('canInsertNextSubmissionVersion', () => {
    it('allows the first submission', () => {
      expect(canInsertNextSubmissionVersion(null)).toEqual({
        allowed: true,
        reason: 'no_prior_submission',
      });
    });

    it('blocks SUBMISSION_UNKNOWN until reconcile', () => {
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'SUBMISSION_UNKNOWN',
          reconciliationResult: 'NONE',
          stripeIdempotencyKey: 'winger-ra:return:ret-1:v1',
          submittedAt: null,
          stripeRefundId: null,
        }),
      ).toEqual({
        allowed: false,
        reason: 'submission_unknown_requires_reconcile',
      });
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'SUBMISSION_UNKNOWN',
          reconciliationResult: 'NONE',
          stripeIdempotencyKey: 'winger-ra:return:ret-1:v1',
          submittedAt: new Date(),
          stripeRefundId: null,
        }).reason,
      ).toBe('unresolved_claimed_stripe_create');
    });

    it('allows a new version only after confirmed NO_MATCH', () => {
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'FAILED',
          reconciliationResult: 'NO_MATCH',
          stripeIdempotencyKey: 'winger-ra:return:ret-1:v1',
          submittedAt: new Date(),
        }),
      ).toEqual({ allowed: true, reason: 'confirmed_no_match' });
    });

    it('blocks AMBIGUOUS and successful priors', () => {
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'PENDING',
          reconciliationResult: 'AMBIGUOUS',
          stripeIdempotencyKey: 'k',
          submittedAt: null,
        }).allowed,
      ).toBe(false);
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'SUCCEEDED',
          reconciliationResult: 'MATCHED',
          stripeIdempotencyKey: 'k',
          submittedAt: new Date(),
        }).allowed,
      ).toBe(false);
    });

    it('allows a new version after confirmed failed/canceled object', () => {
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'FAILED',
          reconciliationResult: 'MATCHED',
          stripeIdempotencyKey: 'k',
          submittedAt: new Date(),
          stripeRefundId: 're_fail',
        }),
      ).toEqual({
        allowed: true,
        reason: 'confirmed_stripe_refund_failed_or_canceled',
      });
    });

    it('blocks FAILED until reconcile confirms the object', () => {
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'FAILED',
          reconciliationResult: 'NONE',
          stripeIdempotencyKey: 'k',
          submittedAt: new Date(),
        }).allowed,
      ).toBe(false);
    });
  });

  describe('canRetryStripeCreateSameVersion', () => {
    it('blocks when a Stripe refund id is already known (pending/requires_action/failed)', () => {
      expect(
        canRetryStripeCreateSameVersion({
          version: 1,
          outcome: 'PENDING',
          reconciliationResult: 'MATCHED',
          stripeIdempotencyKey: 'k',
          submittedAt: new Date(),
          stripeRefundId: 're_pending',
        }).allowed,
      ).toBe(false);
    });

    it('allows PENDING without a Stripe id', () => {
      expect(
        canRetryStripeCreateSameVersion({
          version: 1,
          outcome: 'PENDING',
          reconciliationResult: 'NONE',
          stripeIdempotencyKey: 'k',
          submittedAt: null,
          stripeRefundId: null,
        }).allowed,
      ).toBe(true);
    });

    it('treats in-flight PENDING+submittedAt+no id as same-key recovery only inside 24h', () => {
      const submittedAt = new Date('2026-11-15T00:00:00.000Z');
      expect(
        isInFlightUncertainSubmission({
          outcome: 'PENDING',
          submittedAt,
          stripeRefundId: null,
        }),
      ).toBe(true);
      expect(
        canRetryStripeCreateSameVersion(
          {
            version: 1,
            outcome: 'PENDING',
            reconciliationResult: 'NONE',
            stripeIdempotencyKey: 'k',
            submittedAt,
            stripeRefundId: null,
          },
          new Date(submittedAt.getTime() + 60_000),
        ).reason,
      ).toBe('inflight_same_key_recovery');
      expect(
        canRetryStripeCreateSameVersion(
          {
            version: 1,
            outcome: 'PENDING',
            reconciliationResult: 'NONE',
            stripeIdempotencyKey: 'k',
            submittedAt,
            stripeRefundId: null,
          },
          new Date(submittedAt.getTime() + STRIPE_IDEMPOTENCY_RETAIN_MS),
        ).allowed,
      ).toBe(false);
    });

    it('keeps SUBMISSION_UNKNOWN after claimed create unresolved (never auto next version)', () => {
      const submittedAt = new Date();
      expect(
        isUnresolvedClaimedStripeCreate({
          outcome: 'SUBMISSION_UNKNOWN',
          submittedAt,
          stripeRefundId: null,
        }),
      ).toBe(true);
      expect(
        canInsertNextSubmissionVersion({
          version: 1,
          outcome: 'SUBMISSION_UNKNOWN',
          reconciliationResult: 'NONE',
          stripeIdempotencyKey: 'k',
          submittedAt,
          stripeRefundId: null,
        }),
      ).toEqual({
        allowed: false,
        reason: 'unresolved_claimed_stripe_create',
      });
    });
  });

  describe('isApplyEligibleStripeSuccess', () => {
    it('requires attempt STRIPE_SUCCEEDED and submission SUCCEEDED with id', () => {
      expect(
        isApplyEligibleStripeSuccess({
          attemptStatus: 'STRIPE_SUCCEEDED',
          submissionOutcome: 'SUCCEEDED',
          submissionStripeRefundId: 're_1',
        }),
      ).toBe(true);
      expect(
        isApplyEligibleStripeSuccess({
          attemptStatus: 'PENDING',
          submissionOutcome: 'PENDING',
          submissionStripeRefundId: 're_pending',
        }),
      ).toBe(false);
      expect(
        isApplyEligibleStripeSuccess({
          attemptStatus: 'STRIPE_SUCCEEDED',
          submissionOutcome: 'SUCCEEDED',
          submissionStripeRefundId: 're_1',
          succeededSubmissionCount: 2,
        }),
      ).toBe(false);
    });
  });

  describe('requiresReconcileBeforeStripeCreate', () => {
    it('requires reconcile for SUBMISSION_UNKNOWN', () => {
      expect(
        requiresReconcileBeforeStripeCreate({
          outcome: 'SUBMISSION_UNKNOWN',
          submittedAt: new Date(),
        }),
      ).toBe(true);
    });

    it('requires reconcile when the submission is older than 24 hours', () => {
      const submittedAt = new Date('2026-11-13T00:00:00.000Z');
      const now = new Date('2026-11-15T01:00:00.000Z');
      expect(
        requiresReconcileBeforeStripeCreate({
          outcome: 'PENDING',
          submittedAt,
          now,
        }),
      ).toBe(true);
    });

    it('does not require reconcile for a fresh PENDING submission', () => {
      const submittedAt = new Date('2026-11-15T00:30:00.000Z');
      const now = new Date('2026-11-15T01:00:00.000Z');
      expect(
        requiresReconcileBeforeStripeCreate({
          outcome: 'PENDING',
          submittedAt,
          now,
        }),
      ).toBe(false);
    });
  });

  describe('isRefundAttemptV1Enabled', () => {
    it('is off by default and on for truthy flag values', () => {
      expect(isRefundAttemptV1Enabled({} as NodeJS.ProcessEnv)).toBe(false);
      expect(
        isRefundAttemptV1Enabled({ [REFUND_ATTEMPT_V1_ENV]: 'true' } as NodeJS.ProcessEnv),
      ).toBe(true);
      expect(
        isRefundAttemptV1Enabled({ [REFUND_ATTEMPT_V1_ENV]: '1' } as NodeJS.ProcessEnv),
      ).toBe(true);
    });
  });
});
