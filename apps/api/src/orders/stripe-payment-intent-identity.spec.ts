import { assertStripePaymentIntentMatchesOrder } from './stripe-payment-intent-identity';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    stripePaymentIntentId: null as string | null,
    paymentMode: 'test',
    paymentAmount: 58.99,
    total: 58.99,
    paymentCurrency: 'USD',
    currency: 'USD',
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    status: 'succeeded',
    amount: 5899,
    amountReceived: 5899,
    currency: 'usd',
    livemode: false,
    metadataOrderId: 'ord-1',
    ...overrides,
  };
}

describe('assertStripePaymentIntentMatchesOrder', () => {
  it('accepts a valid succeeded PaymentIntent', () => {
    const result = assertStripePaymentIntentMatchesOrder({
      order: order(),
      intent: intent(),
      requireSucceeded: true,
    });
    expect(result).toEqual({
      ok: true,
      expectedMinor: 5899,
      currency: 'usd',
      paymentMode: 'test',
      status: 'succeeded',
    });
  });

  it('accepts TZS payment amounts without double multiplication', () => {
    const result = assertStripePaymentIntentMatchesOrder({
      order: order({
        paymentAmount: 10000.5,
        total: 10000.5,
        paymentCurrency: 'TZS',
        currency: 'USD',
      }),
      intent: intent({
        amount: 1_000_050,
        amountReceived: 1_000_050,
        currency: 'tzs',
      }),
      requireSucceeded: true,
    });
    expect(result).toMatchObject({
      ok: true,
      expectedMinor: 1_000_050,
      currency: 'tzs',
    });
    if (result.ok) {
      expect(result.expectedMinor).not.toBe(100_005_000);
    }
  });

  it('rejects wrong metadata order id', () => {
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order(),
        intent: intent({ metadataOrderId: 'ord-other' }),
      }).ok,
    ).toBe(false);
  });

  it('rejects bound PaymentIntent mismatch', () => {
    const result = assertStripePaymentIntentMatchesOrder({
      order: order({ stripePaymentIntentId: 'pi_bound' }),
      intent: intent({ id: 'pi_other' }),
    });
    expect(result).toMatchObject({ ok: false, code: 'payment_intent_mismatch' });
  });

  it('rejects wrong amount and currency', () => {
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order(),
        intent: intent({ amount: 1000 }),
      }),
    ).toMatchObject({ ok: false, code: 'amount_mismatch' });
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order(),
        intent: intent({ currency: 'tzs' }),
      }),
    ).toMatchObject({ ok: false, code: 'currency_mismatch' });
  });

  it('rejects wrong livemode and non-card payment modes', () => {
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order({ paymentMode: 'test' }),
        intent: intent({ livemode: true }),
      }),
    ).toMatchObject({ ok: false, code: 'livemode_mismatch' });
    for (const paymentMode of ['demo', 'cod', 'lipa']) {
      expect(
        assertStripePaymentIntentMatchesOrder({
          order: order({ paymentMode }),
          intent: intent(),
        }),
      ).toMatchObject({ ok: false, code: 'payment_mode_not_card' });
    }
  });

  it('rejects insufficient or excess amount_received when succeeded is required', () => {
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order(),
        intent: intent({ amountReceived: 5898 }),
        requireSucceeded: true,
      }),
    ).toMatchObject({ ok: false, code: 'amount_received_mismatch' });
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order(),
        intent: intent({ amountReceived: 5900 }),
        requireSucceeded: true,
      }),
    ).toMatchObject({ ok: false, code: 'amount_received_mismatch' });
  });

  it('allows non-succeeded status when succeeded is not required', () => {
    const result = assertStripePaymentIntentMatchesOrder({
      order: order(),
      intent: intent({
        status: 'canceled',
        amountReceived: null,
      }),
      requireSucceeded: false,
    });
    expect(result).toMatchObject({ ok: true, status: 'canceled' });
  });

  it('rejects invalid persisted payment amounts without inventing a valid charge', () => {
    expect(
      assertStripePaymentIntentMatchesOrder({
        order: order({ paymentAmount: 10.001, total: 10.001 }),
        intent: intent({ amount: 1000, amountReceived: 1000 }),
        requireSucceeded: true,
      }),
    ).toMatchObject({ ok: false, code: 'invalid_order_amount' });
  });
});
