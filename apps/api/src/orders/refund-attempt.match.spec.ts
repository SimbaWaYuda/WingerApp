import {
  classifyRefundReconciliation,
  isExactFingerprintMatch,
  isUncertainPartialMatch,
  sanitizeRefundErrorDetail,
  type MatchableStripeRefund,
  type RefundFingerprint,
} from './refund-attempt.match';

const fingerprint: RefundFingerprint = {
  orderId: 'ord-1',
  operationKey: 'return:ret-1',
  amountCents: 1000,
  currency: 'usd',
  returnRequestId: 'ret-1',
};

function refund(
  partial: Partial<MatchableStripeRefund> & { id: string },
): MatchableStripeRefund {
  const { metadata: metaOverride, ...rest } = partial;
  return {
    amount: 1000,
    currency: 'usd',
    status: 'succeeded',
    ...rest,
    // Explicit metadata replaces defaults so incomplete-metadata cases stay incomplete.
    metadata:
      metaOverride ??
      ({
        orderId: 'ord-1',
        operationKey: 'return:ret-1',
        returnRequestId: 'ret-1',
      } as Record<string, string>),
  };
}

describe('refund-attempt.match', () => {
  it('matches exact fingerprints case-insensitively on currency', () => {
    expect(
      isExactFingerprintMatch(
        refund({ id: 're_1', currency: 'USD' }),
        fingerprint,
      ),
    ).toBe(true);
  });

  it('rejects wrong amount or missing operationKey as exact', () => {
    expect(
      isExactFingerprintMatch(refund({ id: 're_1', amount: 999 }), fingerprint),
    ).toBe(false);
    expect(
      isExactFingerprintMatch(
        refund({
          id: 're_1',
          metadata: { orderId: 'ord-1', returnRequestId: 'ret-1' },
        }),
        fingerprint,
      ),
    ).toBe(false);
  });

  it('treats incomplete metadata as uncertain partial, never exact', () => {
    const partial = refund({
      id: 're_legacy',
      metadata: { orderId: 'ord-1' },
    });
    expect(isExactFingerprintMatch(partial, fingerprint)).toBe(false);
    expect(isUncertainPartialMatch(partial, fingerprint)).toBe(true);
  });

  it('classifies one live exact match', () => {
    const result = classifyRefundReconciliation(
      [refund({ id: 're_live', status: 'pending' })],
      fingerprint,
    );
    expect(result).toEqual({
      kind: 'MATCHED_LIVE',
      refund: expect.objectContaining({ id: 're_live' }),
    });
  });

  it('classifies one failed exact match as MATCHED_FAILED not NO_MATCH', () => {
    const result = classifyRefundReconciliation(
      [refund({ id: 're_fail', status: 'canceled' })],
      fingerprint,
    );
    expect(result.kind).toBe('MATCHED_FAILED');
  });

  it('classifies multiple exact matches as AMBIGUOUS', () => {
    const result = classifyRefundReconciliation(
      [refund({ id: 're_a' }), refund({ id: 're_b' })],
      fingerprint,
    );
    expect(result).toEqual({
      kind: 'AMBIGUOUS',
      reason: 'ambiguous_multiple_exact',
    });
  });

  it('classifies partial-only lists as AMBIGUOUS not NO_MATCH', () => {
    const result = classifyRefundReconciliation(
      [
        refund({
          id: 're_partial',
          metadata: { orderId: 'ord-1' },
        }),
      ],
      fingerprint,
    );
    expect(result.kind).toBe('AMBIGUOUS');
  });

  it('classifies empty exact+partial as NO_MATCH', () => {
    const result = classifyRefundReconciliation(
      [
        refund({
          id: 're_other',
          amount: 50,
          metadata: {
            orderId: 'ord-other',
            operationKey: 'return:other',
            returnRequestId: 'other',
          },
        }),
      ],
      fingerprint,
    );
    expect(result).toEqual({ kind: 'NO_MATCH' });
  });

  it('sanitizes errors without dumping large payloads', () => {
    const detail = sanitizeRefundErrorDetail({
      stripeStatus: 'failed',
      failureReason: 'stolen_card',
      message: 'x'.repeat(500),
    });
    expect(detail).toContain('stripe_status=failed');
    expect(detail.length).toBeLessThanOrEqual(400);
  });
});
