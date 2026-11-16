import {
  assertStripeAmountMinor,
  fromStripeAmountMinor,
  isSupportedStripePaymentCurrency,
  normalizeStripeCurrency,
  STRIPE_CARD_AMOUNT_MINOR_MAX,
  STRIPE_PAYMENT_CURRENCIES,
  StripeAmountError,
  toStripeAmountMinor,
} from './stripe-amount';

describe('stripe-amount utility', () => {
  describe('currency helpers', () => {
    it('normalises currency codes', () => {
      expect(normalizeStripeCurrency(' usd ')).toBe('USD');
      expect(normalizeStripeCurrency('tzs')).toBe('TZS');
    });

    it('recognises only the current payment allowlist', () => {
      expect(STRIPE_PAYMENT_CURRENCIES).toEqual(['USD', 'TZS']);
      expect(isSupportedStripePaymentCurrency('USD')).toBe(true);
      expect(isSupportedStripePaymentCurrency('tzs')).toBe(true);
      expect(isSupportedStripePaymentCurrency('KES')).toBe(false);
      expect(isSupportedStripePaymentCurrency('JPY')).toBe(false);
    });
  });

  describe('toStripeAmountMinor', () => {
    it('converts USD 10.00 to 1000', () => {
      expect(toStripeAmountMinor(10, 'USD')).toBe(1000);
      expect(toStripeAmountMinor(10.0, 'usd')).toBe(1000);
    });

    it('converts TZS 10000.00 to 1000000', () => {
      expect(toStripeAmountMinor(10000, 'TZS')).toBe(1_000_000);
      expect(toStripeAmountMinor(10000.0, 'tzs')).toBe(1_000_000);
    });

    it('converts TZS 10000.50 to 1000050', () => {
      expect(toStripeAmountMinor(10000.5, 'TZS')).toBe(1_000_050);
      expect(toStripeAmountMinor(10000.5, 'TZS')).toBe(
        Math.round(10000.5 * 100),
      );
    });

    it('accepts exact decimal strings without float drift', () => {
      expect(toStripeAmountMinor('58.99', 'USD')).toBe(5899);
      expect(toStripeAmountMinor('10000.00', 'TZS')).toBe(1_000_000);
      expect(toStripeAmountMinor('10000.50', 'TZS')).toBe(1_000_050);
      expect(toStripeAmountMinor('10', 'USD')).toBe(1000);
    });

    it('rejects USD and TZS sub-cent precision', () => {
      expect(() => toStripeAmountMinor(10.001, 'USD')).toThrow(StripeAmountError);
      expect(() => toStripeAmountMinor(10.004, 'USD')).toThrow(/sub-cent/i);
      expect(() => toStripeAmountMinor(10000.001, 'TZS')).toThrow(/sub-cent/i);
      expect(() => toStripeAmountMinor('10.001', 'USD')).toThrow(/sub-cent/i);
      expect(() => toStripeAmountMinor('10000.123', 'TZS')).toThrow(/sub-cent/i);
    });

    it('rejects negative amounts', () => {
      expect(() => toStripeAmountMinor(-1, 'USD')).toThrow(/greater than zero/i);
      expect(() => toStripeAmountMinor('-10.00', 'TZS')).toThrow(
        /greater than zero/i,
      );
    });

    it('rejects zero', () => {
      expect(() => toStripeAmountMinor(0, 'USD')).toThrow(/greater than zero/i);
      expect(() => toStripeAmountMinor('0.00', 'TZS')).toThrow(
        /greater than zero/i,
      );
    });

    it('rejects NaN and Infinity', () => {
      expect(() => toStripeAmountMinor(Number.NaN, 'USD')).toThrow(/finite/i);
      expect(() => toStripeAmountMinor(Number.POSITIVE_INFINITY, 'USD')).toThrow(
        /finite/i,
      );
      expect(() => toStripeAmountMinor(Number.NEGATIVE_INFINITY, 'TZS')).toThrow(
        /finite/i,
      );
    });

    it('rejects unsupported currencies', () => {
      expect(() => toStripeAmountMinor(10, 'KES')).toThrow(/supported/i);
      expect(() => toStripeAmountMinor(10, 'JPY')).toThrow(/supported/i);
      expect(() => toStripeAmountMinor(10, '')).toThrow(/supported/i);
    });

    it('rejects invalid decimal strings', () => {
      expect(() => toStripeAmountMinor('10.0.0', 'USD')).toThrow(
        /Invalid decimal/i,
      );
      expect(() => toStripeAmountMinor('abc', 'USD')).toThrow(/Invalid decimal/i);
      expect(() => toStripeAmountMinor('', 'USD')).toThrow(/Invalid decimal/i);
      expect(() => toStripeAmountMinor('10.', 'USD')).toThrow(/Invalid decimal/i);
    });

    it('rejects amounts above the Stripe card PaymentIntent digit ceiling', () => {
      const overMaxMajor = (STRIPE_CARD_AMOUNT_MINOR_MAX + 1) / 100;
      expect(() => toStripeAmountMinor(overMaxMajor, 'USD')).toThrow(
        /exceeds card PaymentIntent max/i,
      );
    });

    it('accepts the maximum allowed card minor amount', () => {
      const maxMajor = STRIPE_CARD_AMOUNT_MINOR_MAX / 100;
      expect(toStripeAmountMinor(maxMajor, 'USD')).toBe(
        STRIPE_CARD_AMOUNT_MINOR_MAX,
      );
    });

    it('matches existing Math.round(amount * 100) for valid exact-hundredths fixtures', () => {
      const fixtures = [0.01, 1, 10, 58.99, 10000, 10000.5, 999999.99];
      for (const amount of fixtures) {
        expect(toStripeAmountMinor(amount, 'USD')).toBe(
          Math.round(amount * 100),
        );
        expect(toStripeAmountMinor(amount, 'TZS')).toBe(
          Math.round(amount * 100),
        );
      }
    });

    it('does not double-multiply already-compatible major amounts', () => {
      // 10.00 major → 1000 minor once; not 100000.
      expect(toStripeAmountMinor(10, 'USD')).toBe(1000);
      expect(toStripeAmountMinor(10, 'USD')).not.toBe(100_000);
    });
  });

  describe('assertStripeAmountMinor', () => {
    it('accepts already-minor positive integers', () => {
      expect(assertStripeAmountMinor(1000)).toBe(1000);
      expect(assertStripeAmountMinor(1_000_000)).toBe(1_000_000);
      expect(assertStripeAmountMinor(STRIPE_CARD_AMOUNT_MINOR_MAX)).toBe(
        STRIPE_CARD_AMOUNT_MINOR_MAX,
      );
    });

    it('rejects already-minor fractional values without multiplying', () => {
      expect(() => assertStripeAmountMinor(10.5)).toThrow(/integer/i);
      expect(() => assertStripeAmountMinor(1000.01)).toThrow(/integer/i);
    });

    it('rejects zero by default and allows zero when opted in', () => {
      expect(() => assertStripeAmountMinor(0)).toThrow(/greater than zero/i);
      expect(assertStripeAmountMinor(0, { allowZero: true })).toBe(0);
    });

    it('rejects negative and non-finite minors', () => {
      expect(() => assertStripeAmountMinor(-1)).toThrow(/negative/i);
      expect(() => assertStripeAmountMinor(Number.NaN)).toThrow(/finite/i);
      expect(() =>
        assertStripeAmountMinor(Number.POSITIVE_INFINITY),
      ).toThrow(/finite/i);
    });

    it('rejects minors above the card PaymentIntent ceiling', () => {
      expect(() =>
        assertStripeAmountMinor(STRIPE_CARD_AMOUNT_MINOR_MAX + 1),
      ).toThrow(/exceeds card PaymentIntent max/i);
    });

    it('never multiplies an already-minor value', () => {
      expect(assertStripeAmountMinor(5899)).toBe(5899);
      expect(assertStripeAmountMinor(5899)).not.toBe(589_900);
    });
  });

  describe('fromStripeAmountMinor', () => {
    it('converts 1000 USD minor units to 10', () => {
      expect(fromStripeAmountMinor(1000, 'USD')).toBe(10);
    });

    it('converts TZS minor units back to major', () => {
      expect(fromStripeAmountMinor(1_000_000, 'TZS')).toBe(10000);
      expect(fromStripeAmountMinor(1_000_050, 'TZS')).toBe(10000.5);
    });

    it('rejects unsupported currencies on reverse conversion', () => {
      expect(() => fromStripeAmountMinor(1000, 'JPY')).toThrow(/supported/i);
    });
  });
});
