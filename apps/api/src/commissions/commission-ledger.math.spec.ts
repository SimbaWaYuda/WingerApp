import {
  allocateOldestFirst,
  appliedRefundCredit,
  cashCommissionCollected,
  consumeCreditSources,
  grossCommissionOutstanding,
  netAmountDue,
  normalizePaymentReference,
  planClawbackRestoration,
  planRemittanceCreditInvalidation,
  remainingCredit,
  unappliedRefundCredit,
  unappliedVerifiedCash,
  verifiedUsdFromClaim,
} from './commission-ledger.math';

describe('commission ledger math', () => {
  it('allocates one receipt across lines oldest first and leaves the excess unapplied', () => {
    const slices = allocateOldestFirst(
      [
        { id: 'later', settleableAt: '2026-02-01T00:00:00.000Z', remaining: 40 },
        { id: 'earlier', settleableAt: '2026-01-01T00:00:00.000Z', remaining: 60 },
      ],
      150,
    );
    expect(slices).toEqual([
      { snapshotId: 'earlier', amount: 60 },
      { snapshotId: 'later', amount: 40 },
    ]);
    expect(unappliedVerifiedCash([{ verifiedAmountUsd: 150, cashAllocated: 100 }])).toBe(50);
    expect(cashCommissionCollected([60, 40])).toBe(100);
  });

  it('supports a partial payment of one line', () => {
    expect(
      allocateOldestFirst(
        [{ id: 'line', settleableAt: '2026-01-01T00:00:00.000Z', remaining: 100 }],
        40,
      ),
    ).toEqual([{ snapshotId: 'line', amount: 40 }]);
  });

  it('keeps a credit application out of cash collected and out of gross outstanding', () => {
    const gross = grossCommissionOutstanding([
      { commissionAmount: 100, cashAllocated: 0 },
    ]);
    const applied = appliedRefundCredit([30]);
    expect(gross).toBe(100);
    expect(applied).toBe(30);
    expect(cashCommissionCollected([])).toBe(0);
    expect(netAmountDue(gross, applied, 0)).toBe(70);
    expect(unappliedRefundCredit([{ amount: 30, offsets: 0, applied: 30 }])).toBe(0);
  });

  it('does not reduce outstanding with an unapplied credit', () => {
    const gross = grossCommissionOutstanding([
      { commissionAmount: 100, cashAllocated: 0 },
    ]);
    expect(appliedRefundCredit([])).toBe(0);
    expect(unappliedRefundCredit([{ amount: 30, offsets: 0, applied: 0 }])).toBe(30);
    expect(netAmountDue(gross, 0, 0)).toBe(100);
  });

  it('attributes a mixed credit application to each remittance source', () => {
    const slices = consumeCreditSources(
      [
        { sourceId: 'source-b', createdAt: '2026-02-01T00:00:00.000Z', remaining: 40 },
        { sourceId: 'source-a', createdAt: '2026-01-01T00:00:00.000Z', remaining: 60 },
      ],
      100,
    );
    expect(slices).toEqual([
      { sourceId: 'source-a', amount: 60 },
      { sourceId: 'source-b', amount: 40 },
    ]);
  });

  it('reverses only the credit source funded by the reversed remittance', () => {
    const plan = planRemittanceCreditInvalidation({
      reversalId: 'rev-a',
      creditSources: [{ creditSourceId: 'source-a', creditId: 'credit-1', amount: 60 }],
      applicationSources: [
        {
          id: 'app-source-a',
          creditSourceId: 'source-a',
          active: 60,
          createdAt: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'app-source-b',
          creditSourceId: 'source-b',
          active: 40,
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    });
    expect(plan.applicationSourceReversals).toEqual([
      {
        applicationSourceId: 'app-source-a',
        amount: 60,
        reversalKey: 'remittance-reversal:rev-a:application-source:app-source-a',
      },
    ]);
    expect(plan.offsets).toEqual([
      {
        creditId: 'credit-1',
        amount: 60,
        sources: [{ creditSourceId: 'source-a', amount: 60 }],
      },
    ]);
    const gross = grossCommissionOutstanding([
      { commissionAmount: 100, cashAllocated: 0 },
    ]);
    expect(netAmountDue(gross, 40, 0)).toBe(60);
    expect(cashCommissionCollected([40])).toBe(40);
  });

  it('restores credit used on a refunded line and opens a credit only for the cash portion', () => {
    const plan = planClawbackRestoration({
      snapshotId: 'snap-1',
      activeApplicationSources: [{ id: 'app-source-30', active: 30 }],
      activeCashAllocations: [{ allocationId: 'alloc-70', amount: 70 }],
    });
    expect(plan.applicationSourceReversals).toEqual([
      {
        applicationSourceId: 'app-source-30',
        amount: 30,
        reversalKey: 'clawback:snap-1:application-source:app-source-30',
      },
    ]);
    expect(plan.cashCredit).toEqual({
      sourceEventKey: 'clawback:snap-1',
      amount: 70,
      sources: [{ allocationId: 'alloc-70', amount: 70 }],
    });
    expect(
      unappliedRefundCredit([
        { amount: 30, offsets: 0, applied: 0 },
        { amount: 70, offsets: 0, applied: 0 },
      ]),
    ).toBe(100);
  });

  it('restores a fully credit-funded line without creating a cash credit', () => {
    const plan = planClawbackRestoration({
      snapshotId: 'snap-2',
      activeApplicationSources: [{ id: 'app-source-100', active: 100 }],
      activeCashAllocations: [],
    });
    expect(plan.cashCredit).toBeNull();
    expect(plan.applicationSourceReversals).toHaveLength(1);
  });

  it('removes only the unapplied and applied parts of a reversed source', () => {
    const plan = planRemittanceCreditInvalidation({
      reversalId: 'rev-partial',
      creditSources: [{ creditSourceId: 'source-a', creditId: 'credit-1', amount: 60 }],
      applicationSources: [
        {
          id: 'app-source-a',
          creditSourceId: 'source-a',
          active: 25,
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    });
    expect(plan.applicationSourceReversals[0].amount).toBe(25);
    expect(plan.offsets[0].amount).toBe(60);
    const withOtherSource = planRemittanceCreditInvalidation({
      reversalId: 'rev-partial',
      creditSources: [{ creditSourceId: 'source-a', creditId: 'credit-1', amount: 60 }],
      applicationSources: [
        {
          id: 'app-source-a',
          creditSourceId: 'source-a',
          active: 25,
          createdAt: '2026-03-01T00:00:00.000Z',
        },
        {
          id: 'app-source-b',
          creditSourceId: 'source-b',
          active: 40,
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
    });
    expect(withOtherSource.applicationSourceReversals.map((row) => row.applicationSourceId)).toEqual([
      'app-source-a',
    ]);
    expect(remainingCredit(60, 0, 25)).toBe(35);
    expect(remainingCredit(40, 0, 40)).toBe(0);
    expect(remainingCredit(60, withOtherSource.offsets[0].amount, 0)).toBe(0);
  });

  it('refuses a credit application the sources cannot cover', () => {
    expect(() =>
      consumeCreditSources(
        [{ sourceId: 'source-a', createdAt: '2026-01-01T00:00:00.000Z', remaining: 10 }],
        30,
      ),
    ).toThrow('Credit sources do not cover the application');
  });

  it('normalizes a payment reference and converts TZS with the platform quote', () => {
    expect(normalizePaymentReference(' ab 12 ')).toBe('AB12');
    expect(
      verifiedUsdFromClaim({
        claimedAmount: 25000,
        claimedCurrency: 'TZS',
        settlementCurrency: 'USD',
        quoteBase: 'USD',
        quoteCurrency: 'TZS',
        rate: 2500,
      }),
    ).toBe(10);
    expect(
      verifiedUsdFromClaim({
        claimedAmount: 10,
        claimedCurrency: 'USD',
        settlementCurrency: 'USD',
        quoteBase: 'USD',
        quoteCurrency: 'USD',
        rate: 1,
      }),
    ).toBe(10);
  });

  it('floors net amount due when unapplied cash exceeds the balance', () => {
    expect(netAmountDue(100, 30, 90)).toBe(0);
    expect(unappliedVerifiedCash([{ verifiedAmountUsd: 150, cashAllocated: 0 }])).toBe(150);
  });
});
