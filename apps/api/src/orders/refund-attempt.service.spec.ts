import { RefundAttemptService } from './refund-attempt.service';
import { REFUND_ATTEMPT_V1_ENV } from './refund-attempt.types';

describe('RefundAttemptService (S2.0 skeleton)', () => {
  const prisma = {} as ConstructorParameters<typeof RefundAttemptService>[0];
  const service = new RefundAttemptService(prisma);

  afterEach(() => {
    delete process.env[REFUND_ATTEMPT_V1_ENV];
  });

  it('reports the feature flag without touching refund execution paths', () => {
    expect(service.isV1Enabled()).toBe(false);
    process.env[REFUND_ATTEMPT_V1_ENV] = 'true';
    expect(service.isV1Enabled()).toBe(true);
  });

  it('builds operation and Stripe idempotency keys for each kind', () => {
    expect(service.operationKey('RETURN', 'ret-1')).toBe('return:ret-1');
    expect(service.operationKey('ORDER_CANCEL', 'ord-1')).toBe('cancel:ord-1');
    expect(service.stripeIdempotencyKey('return:ret-1', 1)).toBe(
      'winger-ra:return:ret-1:v1',
    );
  });

  it('exposes submission policy helpers used by later stages', () => {
    expect(service.canOpenNextSubmission(null).allowed).toBe(true);
    expect(
      service.mustReconcileBeforeCreate({
        outcome: 'SUBMISSION_UNKNOWN',
        submittedAt: new Date(),
      }),
    ).toBe(true);
  });

  it('keeps Stripe/apply entry points unimplemented until later stages', async () => {
    await expect(
      service.ensureAttemptForOperation({
        kind: 'RETURN',
        operationKey: 'return:ret-1',
        orderId: 'ord-1',
        actorUserId: 'u-1',
        stripePaymentIntentId: 'pi_1',
        amount: 10,
        amountCents: 1000,
        currency: 'usd',
      }),
    ).rejects.toThrow(/S2\.1 not started/);
    await expect(
      service.reconcileSubmission({
        refundAttemptId: 'ra-1',
        submissionId: 'sub-1',
      }),
    ).rejects.toThrow(/S2\.1 not started/);
    await expect(
      service.applySuccessfulRefund({ refundAttemptId: 'ra-1' }),
    ).rejects.toThrow(/S2\.2 not started/);
  });
});
