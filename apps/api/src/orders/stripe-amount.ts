/**
 * Shared Stripe amount conversion for Winger card payments.
 *
 * Current allowlist: USD and TZS only. Both are two-decimal currencies in the
 * Stripe API (minor unit = major × 100). Zero-decimal currencies are not enabled.
 *
 * Amount boundary: Stripe card PaymentIntents allow up to 12 digits in `amount`
 * for most card networks (max 999_999_999_999 minor units). See Stripe
 * "Maximum charge amounts" / currencies docs. This helper uses that card-payment
 * ceiling because Winger charges via PaymentIntent + card.
 */

export const STRIPE_PAYMENT_CURRENCIES = ['USD', 'TZS'] as const;
export type StripePaymentCurrency = (typeof STRIPE_PAYMENT_CURRENCIES)[number];

/** Max Stripe `amount` for card PaymentIntents (12 digits). */
export const STRIPE_CARD_AMOUNT_MINOR_MAX = 999_999_999_999;

/** Same ε as assertExactHundredthsAmount in shipment-refund-hold.types.ts */
const HUNDREDTHS_EPSILON = 1e-8;

export class StripeAmountError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'StripeAmountError';
    this.code = code;
  }
}

export function normalizeStripeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

export function isSupportedStripePaymentCurrency(code: string): boolean {
  const normalized = normalizeStripeCurrency(code);
  return (STRIPE_PAYMENT_CURRENCIES as readonly string[]).includes(normalized);
}

function assertSupportedCurrency(code: string): StripePaymentCurrency {
  const normalized = normalizeStripeCurrency(code);
  if (!isSupportedStripePaymentCurrency(normalized)) {
    throw new StripeAmountError(
      'unsupported_currency',
      `Currency ${normalized || '(empty)'} is not a supported Stripe payment currency`,
    );
  }
  return normalized as StripePaymentCurrency;
}

/**
 * Parse a major-unit amount from number or decimal string into exact hundredths
 * as an integer minor count, without silent sub-cent rounding.
 */
function majorToMinorExact(major: number | string): number {
  if (typeof major === 'string') {
    const trimmed = major.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      throw new StripeAmountError(
        'invalid_decimal_string',
        `Invalid decimal amount string: ${major}`,
      );
    }
    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [wholePart, fracPart = ''] = unsigned.split('.');
    if (fracPart.length > 2) {
      throw new StripeAmountError(
        'amount_sub_cent',
        `Amount ${major} has unsupported sub-cent precision`,
      );
    }
    const whole = Number(wholePart);
    if (!Number.isSafeInteger(whole)) {
      throw new StripeAmountError(
        'amount_unsafe_integer',
        `Amount ${major} is outside the safe integer range`,
      );
    }
    const fracPadded = `${fracPart}00`.slice(0, 2);
    const frac = Number(fracPadded);
    const minor = whole * 100 + frac;
    if (!Number.isSafeInteger(minor)) {
      throw new StripeAmountError(
        'amount_unsafe_integer',
        `Amount ${major} exceeds safe integer minor units`,
      );
    }
    return negative ? -minor : minor;
  }

  if (typeof major !== 'number' || !Number.isFinite(major)) {
    throw new StripeAmountError(
      'amount_not_finite',
      'Amount must be a finite number',
    );
  }

  // Match assertExactHundredthsAmount: reject non-exact hundredths (no silent round).
  const scaled = major * 100;
  const nearest = Math.round(scaled);
  if (Math.abs(scaled - nearest) > HUNDREDTHS_EPSILON) {
    throw new StripeAmountError(
      'amount_sub_cent',
      `Amount ${major} has unsupported sub-cent precision`,
    );
  }
  // Compatible with existing call sites: Math.round(amount * 100) for exact hundredths.
  return nearest;
}

function assertMinorWithinCardBound(minor: number): void {
  if (!Number.isSafeInteger(minor)) {
    throw new StripeAmountError(
      'amount_unsafe_integer',
      'Stripe amount must be a safe integer',
    );
  }
  if (Math.abs(minor) > STRIPE_CARD_AMOUNT_MINOR_MAX) {
    throw new StripeAmountError(
      'amount_exceeds_stripe_card_max',
      `Stripe amount ${minor} exceeds card PaymentIntent max ${STRIPE_CARD_AMOUNT_MINOR_MAX}`,
    );
  }
}

/**
 * Convert a major-unit amount to Stripe minor units for USD/TZS (×100).
 * Rejects zero and negative values.
 */
export function toStripeAmountMinor(
  major: number | string,
  currency: string,
): number {
  assertSupportedCurrency(currency);
  const minor = majorToMinorExact(major);
  if (minor <= 0) {
    throw new StripeAmountError(
      'amount_not_positive',
      'Stripe amount must be greater than zero',
    );
  }
  assertMinorWithinCardBound(minor);
  return minor;
}

/**
 * Convert Stripe minor units back to major units for USD/TZS (÷100).
 */
export function fromStripeAmountMinor(minor: number, currency: string): number {
  assertSupportedCurrency(currency);
  const validated = assertStripeAmountMinor(minor, { allowZero: true });
  return validated / 100;
}

/**
 * Validate a value that is already in Stripe minor units.
 * Does not multiply. Rejects non-integers and out-of-range values.
 */
export function assertStripeAmountMinor(
  minor: number,
  options?: { allowZero?: boolean },
): number {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) {
    throw new StripeAmountError(
      'amount_not_finite',
      'Stripe minor amount must be a finite number',
    );
  }
  if (!Number.isInteger(minor)) {
    throw new StripeAmountError(
      'amount_not_integer',
      `Stripe minor amount ${minor} must be an integer`,
    );
  }
  if (minor < 0) {
    throw new StripeAmountError(
      'amount_negative',
      'Stripe minor amount must not be negative',
    );
  }
  if (minor === 0 && !options?.allowZero) {
    throw new StripeAmountError(
      'amount_not_positive',
      'Stripe minor amount must be greater than zero',
    );
  }
  assertMinorWithinCardBound(minor);
  return minor;
}
