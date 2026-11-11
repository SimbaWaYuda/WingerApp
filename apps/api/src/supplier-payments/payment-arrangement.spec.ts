import {
  PaymentArrangementPreference,
  SupplierPaymentProfileStatus,
} from '@prisma/client';
import {
  effectivePaymentArrangement,
  isValidLipaOrTillNumber,
  normalizeLipaOrTillNumber,
} from './payment-arrangement';

describe('payment-arrangement helpers', () => {
  it('defaults to Winger-managed without an approved direct profile', () => {
    expect(effectivePaymentArrangement(null)).toBe(
      PaymentArrangementPreference.WINGER_MANAGED,
    );
    expect(
      effectivePaymentArrangement({
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        status: SupplierPaymentProfileStatus.PENDING_REVIEW,
      }),
    ).toBe(PaymentArrangementPreference.WINGER_MANAGED);
    expect(
      effectivePaymentArrangement({
        preference: PaymentArrangementPreference.WINGER_MANAGED,
        status: SupplierPaymentProfileStatus.APPROVED,
      }),
    ).toBe(PaymentArrangementPreference.WINGER_MANAGED);
  });

  it('enables supplier-direct only when approved and preferred', () => {
    expect(
      effectivePaymentArrangement({
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        status: SupplierPaymentProfileStatus.APPROVED,
      }),
    ).toBe(PaymentArrangementPreference.SUPPLIER_DIRECT);
  });

  it('normalizes and validates Lipa / Till numbers', () => {
    expect(normalizeLipaOrTillNumber(' till 123456 ')).toBe('TILL123456');
    expect(isValidLipaOrTillNumber('123456')).toBe(true);
    expect(isValidLipaOrTillNumber('TILL1234')).toBe(true);
    expect(isValidLipaOrTillNumber('12')).toBe(false);
    expect(isValidLipaOrTillNumber('bad number!')).toBe(false);
  });
});
