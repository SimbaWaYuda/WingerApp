import {
  StripeAmountError,
  normalizeStripeCurrency,
  toStripeAmountMinor,
} from './stripe-amount';

/** Stripe-retrieved PaymentIntent fields required for webhook identity checks. */
export type StripePaymentIntentSnapshot = {
  id: string;
  status: string;
  amount: number;
  amountReceived: number | null;
  currency: string;
  livemode: boolean;
  metadataOrderId: string | null;
};

export type OrderPaymentIdentity = {
  id: string;
  stripePaymentIntentId: string | null;
  paymentMode: string;
  paymentAmount?: { toString(): string } | number | string | null;
  total: { toString(): string } | number | string;
  paymentCurrency?: string | null;
  currency: string;
};

export type StripePaymentIntentIdentityOk = {
  ok: true;
  expectedMinor: number;
  currency: string;
  paymentMode: 'test' | 'live';
  status: string;
};

export type StripePaymentIntentIdentityFail = {
  ok: false;
  code:
    | 'metadata_order_mismatch'
    | 'payment_intent_mismatch'
    | 'currency_mismatch'
    | 'amount_mismatch'
    | 'amount_received_mismatch'
    | 'payment_mode_not_card'
    | 'livemode_mismatch'
    | 'status_not_succeeded'
    | 'invalid_order_amount';
  message: string;
};

export type StripePaymentIntentIdentityResult =
  | StripePaymentIntentIdentityOk
  | StripePaymentIntentIdentityFail;

function majorSource(order: OrderPaymentIdentity): number | string {
  if (order.paymentAmount != null && order.paymentAmount !== '') {
    return typeof order.paymentAmount === 'object'
      ? order.paymentAmount.toString()
      : order.paymentAmount;
  }
  return typeof order.total === 'object' ? order.total.toString() : order.total;
}

/**
 * Pure PaymentIntent ↔ order identity/amount/mode validator for card webhooks.
 * Callers must retrieve the PaymentIntent from Stripe before invoking this.
 */
export function assertStripePaymentIntentMatchesOrder(params: {
  order: OrderPaymentIdentity;
  intent: StripePaymentIntentSnapshot;
  /** When true, require status=succeeded and amount_received === expectedMinor. */
  requireSucceeded?: boolean;
}): StripePaymentIntentIdentityResult {
  const { order, intent } = params;
  const metaOrderId = (intent.metadataOrderId ?? '').trim();
  if (!metaOrderId || metaOrderId !== order.id) {
    return {
      ok: false,
      code: 'metadata_order_mismatch',
      message: 'PaymentIntent metadata.orderId does not match order id',
    };
  }

  const bound = (order.stripePaymentIntentId ?? '').trim();
  if (bound && bound !== intent.id) {
    return {
      ok: false,
      code: 'payment_intent_mismatch',
      message: 'Order is bound to a different PaymentIntent',
    };
  }

  const paymentMode = order.paymentMode.trim().toLowerCase();
  if (paymentMode !== 'test' && paymentMode !== 'live') {
    return {
      ok: false,
      code: 'payment_mode_not_card',
      message: `Order paymentMode ${order.paymentMode} is not a card webhook path`,
    };
  }

  const expectLive = paymentMode === 'live';
  if (intent.livemode !== expectLive) {
    return {
      ok: false,
      code: 'livemode_mismatch',
      message: 'PaymentIntent livemode does not match order paymentMode',
    };
  }

  const currency = normalizeStripeCurrency(
    order.paymentCurrency || order.currency || 'USD',
  ).toLowerCase();
  const intentCurrency = normalizeStripeCurrency(intent.currency).toLowerCase();
  if (intentCurrency !== currency) {
    return {
      ok: false,
      code: 'currency_mismatch',
      message: 'PaymentIntent currency does not match order payment currency',
    };
  }

  let expectedMinor: number;
  try {
    expectedMinor = toStripeAmountMinor(majorSource(order), currency);
  } catch (error) {
    const message =
      error instanceof StripeAmountError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'Invalid order payment amount';
    return { ok: false, code: 'invalid_order_amount', message };
  }

  if (intent.amount !== expectedMinor) {
    return {
      ok: false,
      code: 'amount_mismatch',
      message: 'PaymentIntent amount does not match order payment amount',
    };
  }

  const status = intent.status.trim().toLowerCase();
  if (params.requireSucceeded) {
    if (status !== 'succeeded') {
      return {
        ok: false,
        code: 'status_not_succeeded',
        message: `PaymentIntent status ${intent.status} is not succeeded`,
      };
    }
    if (intent.amountReceived !== expectedMinor) {
      return {
        ok: false,
        code: 'amount_received_mismatch',
        message:
          'PaymentIntent amount_received does not equal the expected charge amount',
      };
    }
  }

  return {
    ok: true,
    expectedMinor,
    currency,
    paymentMode,
    status,
  };
}
