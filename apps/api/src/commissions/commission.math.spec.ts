import {
  assertValidRatePercent,
  buildSnapshotValues,
  commissionBaseFromLine,
  computeCommissionAmount,
  roundMoney,
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
});
