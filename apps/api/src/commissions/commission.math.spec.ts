import {
  assertValidRatePercent,
  buildSnapshotValues,
  commissionBaseFromLine,
  computeCommissionAmount,
  countsAsEarnedRevenue,
  isReportableSettleable,
  roundMoney,
  sumCommissionBuckets,
  sumSupplierPayoutSplit,
  type CommissionMoneyRow,
  type SupplierPayoutSplitRow,
} from './commission.math';

describe('commission.math', () => {
  it('rounds money to cents', () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(10.004)).toBe(10);
  });

  it('computes commission base from selling price × qty (excl tax/delivery)', () => {
    expect(commissionBaseFromLine(99.99, 2)).toBe(199.98);
  });

  it('computes 10% commission on discounted selling price', () => {
    expect(computeCommissionAmount(200, 10)).toBe(20);
    expect(computeCommissionAmount(199.98, 10)).toBe(20);
  });

  it('builds immutable snapshot values', () => {
    expect(buildSnapshotValues({ unitPrice: 50, quantity: 3, ratePercent: 10 })).toEqual({
      commissionBase: 150,
      ratePercent: 10,
      commissionAmount: 15,
    });
  });

  it('rejects invalid rates', () => {
    expect(() => assertValidRatePercent(-1)).toThrow();
    expect(() => assertValidRatePercent(101)).toThrow();
    expect(() => computeCommissionAmount(100, 101)).toThrow();
  });

  it('does not include tax or delivery in the commission base helper', () => {
    const productLine = commissionBaseFromLine(100, 1);
    const tax = 8;
    const delivery = 4.99;
    // Callers must pass only the product line — tax/delivery are tracked elsewhere.
    expect(productLine).toBe(100);
    expect(productLine + tax + delivery).toBe(112.99);
    expect(computeCommissionAmount(productLine, 10)).toBe(10);
    expect(computeCommissionAmount(productLine + tax + delivery, 10)).not.toBe(10);
  });

  it('keeps pending, recognised, settleable and reversed commission distinct', () => {
    const rows: CommissionMoneyRow[] = [
      line({ status: 'PENDING', amount: 10 }),
      line({ status: 'RECOGNIZED', amount: 4, itemStatus: 'SHIPPED' }),
      line({ status: 'SETTLEABLE', amount: 6 }),
      line({ status: 'CLAWED_BACK', amount: 2 }),
      line({ status: 'SETTLEABLE', amount: 99, isDemo: true }),
      line({
        status: 'SETTLEABLE',
        amount: 7,
        itemStatus: 'SHIPPED',
      }),
    ];
    expect(sumCommissionBuckets(rows)).toEqual({
      pendingCommission: 10,
      recognizedCommission: 4,
      settleableCommission: 6,
      reversedCommission: 2,
      earnedRevenue: 10,
    });
    expect(countsAsEarnedRevenue(rows[0])).toBe(false);
    expect(isReportableSettleable(rows[4])).toBe(false);
    expect(isReportableSettleable(rows[5])).toBe(false);
  });

  it('splits card commission still waiting, cash, and payouts already sent', () => {
    const rows: SupplierPayoutSplitRow[] = [
      splitLine({
        amount: 31.9,
        paymentMode: 'stripe',
        transferAmount: 287.1,
        transferCurrency: 'USD',
      }),
      splitLine({ amount: 10, paymentMode: 'cod' }),
      splitLine({ amount: 8, paymentMode: 'cod' }),
      splitLine({ amount: 6, paymentMode: 'cod' }),
      splitLine({ amount: 4, paymentMode: 'card' }),
      splitLine({ status: 'PENDING', amount: 31.9, paymentMode: 'card' }),
    ];
    expect(sumSupplierPayoutSplit(rows)).toEqual({
      commissionWaiting: 4,
      cashCommission: 24,
      payoutsSent: [{ currency: 'USD', amount: 287.1 }],
    });
  });

  it('does not count uncollected COD as earned revenue', () => {
    const uncollected = line({
      status: 'PENDING',
      amount: 5,
      paymentMode: 'cod',
      paymentStatus: 'PENDING',
      itemStatus: 'DELIVERED',
    });
    expect(countsAsEarnedRevenue(uncollected)).toBe(false);
    expect(isReportableSettleable(uncollected)).toBe(false);
  });
});

function splitLine(
  overrides: Partial<SupplierPayoutSplitRow>,
): SupplierPayoutSplitRow {
  return {
    ...line({ status: 'SETTLEABLE', ...overrides }),
    transferAmount: null,
    transferCurrency: null,
    transferReversed: false,
    ...overrides,
  };
}

function line(overrides: Partial<CommissionMoneyRow>): CommissionMoneyRow {
  return {
    status: 'PENDING',
    isDemo: false,
    amount: 1,
    itemStatus: 'DELIVERED',
    paymentStatus: 'PAID',
    paymentMode: 'card',
    supplierId: 'sup-1',
    collectedSupplierIds: [],
    ...overrides,
  };
}
