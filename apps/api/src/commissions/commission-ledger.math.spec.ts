import {
  allocateOldestFirst,
  appliedRefundCredit,
  cashCommissionCollected,
  consumeCreditSources,
  grossCommissionOutstanding,
  netAmountDue,
  netCommissionAmount,
  roundMoney,
  settleableCommissionPlacement,
  normalizePaymentReference,
  planClawbackRestoration,
  planPartialClawback,
  planRemittanceCreditInvalidation,
  proportionalCommissionSlice,
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
    expect(plan.allocationReversals).toEqual([
      {
        allocationId: 'alloc-70',
        amount: 70,
        reversalKey: 'clawback:snap-1:allocation:alloc-70',
      },
    ]);
    const activeCollected = 70 - plan.allocationReversals[0].amount;
    expect(activeCollected).toBe(0);
    expect(activeCollected + plan.cashCredit!.amount).toBe(70);
    expect(
      unappliedVerifiedCash([
        { verifiedAmountUsd: 70, cashAllocated: activeCollected, creditHeld: 70 },
      ]),
    ).toBe(0);
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
    expect(plan.allocationReversals).toEqual([]);
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

describe('partial return commission slices', () => {
  it('returns a $1.00 commission one unit at a time as 0.33, 0.33 and 0.34', () => {
    const first = proportionalCommissionSlice({
      commissionAmount: 1,
      lineQuantity: 3,
      alreadyReturned: 0,
      quantity: 1,
      alreadyClawed: 0,
    });
    const second = proportionalCommissionSlice({
      commissionAmount: 1,
      lineQuantity: 3,
      alreadyReturned: 1,
      quantity: 1,
      alreadyClawed: first,
    });
    const last = proportionalCommissionSlice({
      commissionAmount: 1,
      lineQuantity: 3,
      alreadyReturned: 2,
      quantity: 1,
      alreadyClawed: first + second,
    });
    expect(first).toBe(0.33);
    expect(second).toBe(0.33);
    expect(last).toBe(0.34);
    expect(netCommissionAmount(1, [first, second, last])).toBe(0);
  });

  it('releases the $4 credit and $1 of the $6 cash when half of a $10 line is returned', () => {
    const slice = proportionalCommissionSlice({
      commissionAmount: 10,
      lineQuantity: 2,
      alreadyReturned: 0,
      quantity: 1,
      alreadyClawed: 0,
    });
    expect(slice).toBe(5);
    const plan = planPartialClawback({
      eventKey: 'ret-half',
      retainedAfter: 5,
      activeApplicationSources: [
        {
          id: 'app-source-4',
          active: 4,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      activeCashAllocations: [
        {
          allocationId: 'alloc-6',
          amount: 6,
          createdAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
    expect(plan.applicationSourceReversals).toEqual([
      {
        applicationSourceId: 'app-source-4',
        amount: 4,
        reversalKey: 'return-clawback:ret-half:application-source:app-source-4',
      },
    ]);
    expect(plan.allocationReversals).toEqual([
      {
        allocationId: 'alloc-6',
        amount: 1,
        reversalKey: 'return-clawback:ret-half:allocation:alloc-6',
      },
    ]);
    expect(plan.cashCredit).toEqual({
      sourceEventKey: 'return-clawback:ret-half',
      amount: 1,
      sources: [{ allocationId: 'alloc-6', amount: 1 }],
    });
    const collected = 6 - plan.allocationReversals[0].amount;
    expect(collected).toBe(5);
    expect(collected + plan.cashCredit!.amount).toBe(6);
    expect(grossCommissionOutstanding([{ commissionAmount: 5, cashAllocated: collected }])).toBe(0);
  });

  it('does not open a cash credit for unpaid commission', () => {
    const plan = planPartialClawback({
      eventKey: 'ret-unpaid',
      retainedAfter: 5,
      activeApplicationSources: [],
      activeCashAllocations: [],
    });
    expect(plan.cashCredit).toBeNull();
    expect(plan.allocationReversals).toEqual([]);
    expect(grossCommissionOutstanding([{ commissionAmount: 5, cashAllocated: 0 }])).toBe(5);
  });

  it('leaves another remittance allocation untouched', () => {
    const plan = planPartialClawback({
      eventKey: 'ret-one-source',
      retainedAfter: 5,
      activeApplicationSources: [],
      activeCashAllocations: [
        {
          allocationId: 'older',
          amount: 6,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          allocationId: 'newer',
          amount: 4,
          createdAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    expect(plan.allocationReversals.map((row) => row.allocationId)).toEqual(['older']);
    expect(plan.allocationReversals[0].amount).toBe(5);
  });
});

describe('retained card commission', () => {
  it.each(['stripe', 'test', 'live'])(
    'keeps %s commission in the retained balance',
    (paymentMode) => {
      expect(settleableCommissionPlacement(paymentMode)).toBe('retained');
    },
  );

  it.each(['cod', 'lipa'])(
    'keeps %s commission in the cash outstanding balance',
    (paymentMode) => {
      expect(settleableCommissionPlacement(paymentMode)).toBe('cash');
    },
  );

  it.each(['demo', 'card', ''])(
    'leaves %s commission out of both balances',
    (paymentMode) => {
      expect(settleableCommissionPlacement(paymentMode)).toBe('none');
    },
  );

  it('counts stripe, test, and live once and leaves cash due unchanged', () => {
    const lines = [
      { paymentMode: 'stripe', amount: 31.9, allocated: 0 },
      { paymentMode: 'test', amount: 10, allocated: 0 },
      { paymentMode: 'live', amount: 5, allocated: 0 },
      { paymentMode: 'cod', amount: 12, allocated: 1 },
      { paymentMode: 'cod', amount: 5, allocated: 0 },
      { paymentMode: 'cod', amount: 7, allocated: 0 },
      { paymentMode: 'cod', amount: 12, allocated: 0 },
      { paymentMode: 'cod', amount: 4.8, allocated: 0 },
      { paymentMode: 'lipa', amount: 4.8, allocated: 0 },
    ];
    let retained = 0;
    const cashLines: { commissionAmount: number; cashAllocated: number }[] = [];
    for (const line of lines) {
      const placement = settleableCommissionPlacement(line.paymentMode);
      const selected = ['retained', 'cash'].filter((bucket) => bucket === placement);
      expect(selected).toHaveLength(placement === 'none' ? 0 : 1);
      if (placement === 'retained') retained = roundMoney(retained + line.amount);
      if (placement === 'cash') {
        cashLines.push({
          commissionAmount: line.amount,
          cashAllocated: line.allocated,
        });
      }
    }
    const due = netAmountDue(grossCommissionOutstanding(cashLines), 0, 0);
    expect(retained).toBe(46.9);
    expect(due).toBe(44.6);
    expect(roundMoney(retained + due)).toBe(91.5);
    expect(cashLines.some((line) => line.commissionAmount === 31.9)).toBe(false);
  });

  it('keeps the delivered Stripe commission retained and the cash due at 39.80', () => {
    const lines = [
      { paymentMode: 'stripe', amount: 31.9, allocated: 0 },
      { paymentMode: 'cod', amount: 12, allocated: 1 },
      { paymentMode: 'cod', amount: 5, allocated: 0 },
      { paymentMode: 'cod', amount: 7, allocated: 0 },
      { paymentMode: 'cod', amount: 12, allocated: 0 },
      { paymentMode: 'cod', amount: 4.8, allocated: 0 },
    ];
    let retained = 0;
    const cashLines: { commissionAmount: number; cashAllocated: number }[] = [];
    for (const line of lines) {
      const placement = settleableCommissionPlacement(line.paymentMode);
      if (placement === 'retained') retained = roundMoney(retained + line.amount);
      if (placement === 'cash') {
        cashLines.push({
          commissionAmount: line.amount,
          cashAllocated: line.allocated,
        });
      }
    }
    expect(retained).toBe(31.9);
    expect(netAmountDue(grossCommissionOutstanding(cashLines), 0, 0)).toBe(39.8);
  });
});
