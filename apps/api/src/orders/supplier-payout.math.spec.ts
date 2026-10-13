import { supplierNetSettlement, supplierTransferAmount } from './supplier-payout.math';

describe('supplier payout amount', () => {
  it('pays the item total minus commission and leaves tax and delivery on the platform', () => {
    expect(supplierNetSettlement(100, 10)).toBe(90);
    expect(
      supplierTransferAmount({
        lineTotal: 100,
        commissionAmount: 10,
        settlementCurrency: 'USD',
        paymentCurrency: 'USD',
        fxRate: 1,
      }),
    ).toEqual({ amount: 90, currency: 'USD' });
  });

  it('converts the settlement net with the locked checkout rate', () => {
    expect(
      supplierTransferAmount({
        lineTotal: 40,
        commissionAmount: 4,
        settlementCurrency: 'USD',
        paymentCurrency: 'TZS',
        fxRate: 2500,
      }),
    ).toEqual({ amount: 90000, currency: 'TZS' });
  });

  it('does not transfer a zero or negative net', () => {
    expect(supplierNetSettlement(10, 10)).toBe(0);
    expect(
      supplierTransferAmount({
        lineTotal: 10,
        commissionAmount: 12,
        settlementCurrency: 'USD',
        paymentCurrency: 'USD',
        fxRate: 1,
      }),
    ).toBeNull();
  });
});
