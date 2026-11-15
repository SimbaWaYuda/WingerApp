import {
  canInsertNextSubmissionVersion,
  isRefundAttemptV1Enabled,
  operationKeyForCancelRemaining,
  operationKeyForLineCancel,
  operationKeyForOrderCancel,
  operationKeyForReturn,
  operationKeyForUnsellable,
  REFUND_ATTEMPT_V1_ENV,
  requiresReconcileBeforeStripeCreate,
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
          submittedAt: new Date(),
        }),
      ).toEqual({
        allowed: false,
        reason: 'submission_unknown_requires_reconcile',
      });
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
