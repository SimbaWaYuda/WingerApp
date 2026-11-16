import {
  cardRefundAmount,
  isWithinStripeChargeIdempotencyWindow,
  STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS,
  StripeService,
} from './stripe.service';

describe('StripeService payment safety', () => {
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    }
  });

  it('sends a stable idempotency key when creating a PaymentIntent', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' });
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 5898,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-10099',
      customerEmail: 'amina@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(result).toMatchObject({ status: 'paid', paymentIntentId: 'pi_1', mode: 'test' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 5898,
        payment_method_types: ['card'],
        metadata: expect.objectContaining({ orderId: 'ord-1' }),
      }),
      { idempotencyKey: 'winger-charge-ord-1' },
    );
    expect(create.mock.calls[0][0].automatic_payment_methods).toBeUndefined();
  });

  it('verifies webhook signatures and refuses unsigned events when the secret is missing', () => {
    const constructEvent = jest.fn().mockReturnValue({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_1' } },
    });
    const service = new StripeService();
    service.bindForTests({ webhooks: { constructEvent } } as never, 'test');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const body = Buffer.from('{}');

    expect(service.constructWebhookEvent(body, 'sig_test')).toMatchObject({
      id: 'evt_1',
    });
    expect(constructEvent).toHaveBeenCalledWith(body, 'sig_test', 'whsec_test');

    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect(() => service.constructWebhookEvent(body, 'sig_test')).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
    expect(() => service.constructWebhookEvent(body, undefined)).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });

  it('refunds the PaymentIntent with a stable key and the line share in cents', async () => {
    const create = jest.fn().mockResolvedValue({ id: 're_1', status: 'succeeded' });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 29.5,
      currency: 'USD',
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({
      ok: true,
      refundId: 're_1',
      status: 'succeeded',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 2950,
        metadata: { orderId: 'ord-1', reason: 'return', returnRequestId: 'ret-1' },
      }),
      { idempotencyKey: 'winger-refund-ret-1' },
    );
    expect(Number.isInteger(create.mock.calls[0][0].amount)).toBe(true);
  });

  it('refunds a cancelled order with a stable cancel key', async () => {
    const create = jest.fn().mockResolvedValue({ id: 're_cancel', status: 'succeeded' });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 58.99,
      currency: 'USD',
      idempotencyKey: 'winger-cancel-ord-1',
      orderId: 'ord-1',
      reason: 'cancel',
    });

    expect(result).toEqual({
      ok: true,
      refundId: 're_cancel',
      status: 'succeeded',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 5899,
        metadata: { orderId: 'ord-1', reason: 'cancel' },
      }),
      { idempotencyKey: 'winger-cancel-ord-1' },
    );
  });

  it('converts TZS major units to Stripe minor units for card refunds', async () => {
    const create = jest.fn().mockResolvedValue({ id: 're_tzs', status: 'succeeded' });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10000.5,
      currency: 'TZS',
      idempotencyKey: 'winger-refund-ret-tzs',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({
      ok: true,
      refundId: 're_tzs',
      status: 'succeeded',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 1_000_050,
      }),
      { idempotencyKey: 'winger-refund-ret-tzs' },
    );
  });

  it('rejects unsupported refund currencies before calling Stripe', async () => {
    const create = jest.fn();
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10,
      currency: 'KES',
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/supported/i);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects zero, negative, and sub-cent refund amounts before calling Stripe', async () => {
    const create = jest.fn();
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    for (const amount of [0, -1, 10.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await service.refundCardCharge({
        paymentIntentId: 'pi_1',
        amount,
        currency: 'USD',
        idempotencyKey: 'winger-refund-ret-1',
        orderId: 'ord-1',
        returnRequestId: 'ret-1',
      });
      expect(result.ok).toBe(false);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('treats an already-refunded charge as success so a retry can finish the ledger', async () => {
    const service = new StripeService();
    service.bindForTests(
      { refunds: { create: jest.fn().mockRejectedValue(new Error('Charge already refunded')) } } as never,
      'test',
    );

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10,
      currency: 'USD',
      idempotencyKey: 'winger-cancel-ord-1',
      orderId: 'ord-1',
      reason: 'cancel',
    });

    expect(result).toEqual({
      ok: true,
      refundId: 'already_refunded',
      status: 'succeeded',
    });
  });

  it('exposes pending status without treating ok as terminal success', async () => {
    const create = jest.fn().mockResolvedValue({ id: 're_pending', status: 'pending' });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10,
      currency: 'USD',
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({
      ok: true,
      refundId: 're_pending',
      status: 'pending',
    });
  });

  it('reports a Stripe refund failure without throwing', async () => {
    const service = new StripeService();
    service.bindForTests(
      { refunds: { create: jest.fn().mockRejectedValue(new Error('insufficient funds')) } } as never,
      'test',
    );

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10,
      currency: 'USD',
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({
      ok: false,
      message: 'insufficient funds',
      uncertain: false,
    });
  });

  it('lists PaymentIntent refunds across pages until exhausted', async () => {
    const list = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 're_1',
            amount: 100,
            currency: 'usd',
            status: 'succeeded',
            metadata: { orderId: 'ord-1', operationKey: 'return:ret-1' },
          },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 're_2',
            amount: 200,
            currency: 'usd',
            status: 'failed',
            failure_reason: 'expired_or_canceled_card',
            metadata: { orderId: 'ord-1' },
          },
        ],
        has_more: false,
      });
    const service = new StripeService();
    service.bindForTests({ refunds: { list } } as never, 'test');

    const result = await service.listRefundsForPaymentIntent('pi_1');
    expect(result).toEqual({
      ok: true,
      exhausted: true,
      refunds: [
        expect.objectContaining({ id: 're_1', amount: 100 }),
        expect.objectContaining({
          id: 're_2',
          failureReason: 'expired_or_canceled_card',
        }),
      ],
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toEqual(
      expect.objectContaining({ starting_after: 're_1' }),
    );
  });

  it('creates a V1 attempt refund with operationKey metadata and idempotency key', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 're_v1',
      status: 'pending',
      failure_reason: null,
    });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.createRefundForAttempt({
      paymentIntentId: 'pi_1',
      amountCents: 1000,
      currency: 'USD',
      orderId: 'ord-1',
      operationKey: 'return:ret-1',
      idempotencyKey: 'winger-ra:return:ret-1:v1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({
      ok: true,
      refund: { id: 're_v1', status: 'pending', failureReason: null },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 1000,
        currency: 'usd',
        metadata: {
          orderId: 'ord-1',
          operationKey: 'return:ret-1',
          returnRequestId: 'ret-1',
        },
      }),
      { idempotencyKey: 'winger-ra:return:ret-1:v1' },
    );
    // Already-minor path: amountCents must not be multiplied again.
    expect(create.mock.calls[0][0].amount).toBe(1000);
    expect(create.mock.calls[0][0].amount).not.toBe(100_000);
  });

  it('classifies charge network timeouts as uncertain and preserves PaymentIntent id', async () => {
    const err = Object.assign(new Error('socket hang up'), {
      type: 'StripeConnectionError',
      payment_intent: { id: 'pi_timeout' },
    });
    const create = jest.fn().mockRejectedValue(err);
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(result).toMatchObject({
      status: 'uncertain',
      paymentIntentId: 'pi_timeout',
      mode: 'test',
    });
    expect(create).toHaveBeenCalledWith(
      expect.any(Object),
      { idempotencyKey: 'winger-charge-ord-1' },
    );
  });

  it('rejects invalid local payment methods without calling Stripe', async () => {
    const create = jest.fn();
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'not-a-pm',
    });

    expect(result).toMatchObject({ status: 'failed', mode: 'test' });
    expect(create).not.toHaveBeenCalled();
  });

  it('classifies ambiguous Stripe errors without a PaymentIntent id as uncertain', async () => {
    const err = Object.assign(new Error('Invalid API Key provided'), {
      type: 'StripeAuthenticationError',
    });
    const create = jest.fn().mockRejectedValue(err);
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(result).toMatchObject({
      status: 'uncertain',
      mode: 'test',
    });
    expect(result.paymentIntentId).toBeUndefined();
  });

  it('classifies card declines with a retryable PaymentIntent as uncertain', async () => {
    const err = Object.assign(new Error('Your card was declined.'), {
      type: 'StripeCardError',
      code: 'card_declined',
      payment_intent: { id: 'pi_declined' },
    });
    const create = jest.fn().mockRejectedValue(err);
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(result).toMatchObject({
      status: 'uncertain',
      paymentIntentId: 'pi_declined',
      mode: 'test',
    });
  });

  it('classifies only canceled PaymentIntent status as failed', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'pi_canceled', status: 'canceled' });
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');
    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });
    expect(result).toMatchObject({
      status: 'failed',
      paymentIntentId: 'pi_canceled',
    });
  });

  it('classifies requires_payment_method and other open PaymentIntent statuses as uncertain', async () => {
    const service = new StripeService();
    for (const status of [
      'requires_payment_method',
      'processing',
      'requires_action',
      'requires_confirmation',
      'requires_capture',
    ] as const) {
      const create = jest.fn().mockResolvedValue({ id: `pi_${status}`, status });
      service.bindForTests({ paymentIntents: { create } } as never, 'test');
      const result = await service.chargeOrder({
        amountCents: 1000,
        currency: 'usd',
        orderId: 'ord-1',
        orderDisplayId: 'WG-1',
        customerEmail: 'a@example.com',
        idempotencyKey: 'winger-charge-ord-1',
        paymentMethodId: 'pm_card_visa',
      });
      expect(result).toMatchObject({
        status: 'uncertain',
        paymentIntentId: `pi_${status}`,
      });
    }
  });

  it('returns PaymentIntent status from retrievePaymentIntentStatus', async () => {
    const retrieve = jest.fn().mockResolvedValue({
      id: 'pi_1',
      status: 'requires_payment_method',
    });
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { retrieve } } as never, 'test');
    await expect(service.retrievePaymentIntentStatus('pi_1')).resolves.toEqual({
      ok: true,
      id: 'pi_1',
      status: 'requires_payment_method',
    });
  });

  it('marks retrievePaymentIntentStatus failures as not ok', async () => {
    const retrieve = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { retrieve } } as never, 'test');
    await expect(service.retrievePaymentIntentStatus('pi_1')).resolves.toMatchObject({
      ok: false,
      message: 'socket hang up',
    });
  });

  it('confirms an existing PaymentIntent without creating a new one', async () => {
    const confirm = jest.fn().mockResolvedValue({
      id: 'pi_1',
      status: 'succeeded',
    });
    const create = jest.fn();
    const service = new StripeService();
    service.bindForTests(
      { paymentIntents: { confirm, create } } as never,
      'test',
    );

    const result = await service.confirmPaymentIntent({
      paymentIntentId: 'pi_1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(confirm).toHaveBeenCalledWith('pi_1', {
      payment_method: 'pm_card_visa',
    });
    expect(create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'paid',
      paymentIntentId: 'pi_1',
      mode: 'test',
    });
  });

  it('marks confirmPaymentIntent transport failures as uncertain', async () => {
    const confirm = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { confirm } } as never, 'test');

    await expect(
      service.confirmPaymentIntent({
        paymentIntentId: 'pi_1',
        paymentMethodId: 'pm_card_visa',
      }),
    ).resolves.toMatchObject({
      status: 'uncertain',
      message: 'socket hang up',
    });
  });

  it('classifies unrecognised PaymentIntent statuses as uncertain and preserves PaymentIntent id', async () => {
    const create = jest
      .fn()
      .mockResolvedValue({ id: 'pi_future_status', status: 'awaiting_risk_review' });
    const service = new StripeService();
    service.bindForTests({ paymentIntents: { create } } as never, 'test');

    const result = await service.chargeOrder({
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      orderDisplayId: 'WG-1',
      customerEmail: 'a@example.com',
      idempotencyKey: 'winger-charge-ord-1',
      paymentMethodId: 'pm_card_visa',
    });

    expect(result).toMatchObject({
      status: 'uncertain',
      paymentIntentId: 'pi_future_status',
      mode: 'test',
    });
  });

  it('marks createRefundForAttempt transport failures as uncertain', async () => {
    const service = new StripeService();
    service.bindForTests(
      {
        refunds: {
          create: jest.fn().mockRejectedValue(new Error('socket hang up')),
        },
      } as never,
      'test',
    );

    const result = await service.createRefundForAttempt({
      paymentIntentId: 'pi_1',
      amountCents: 1000,
      currency: 'usd',
      orderId: 'ord-1',
      operationKey: 'return:ret-1',
      idempotencyKey: 'winger-ra:return:ret-1:v1',
    });

    expect(result).toEqual({
      ok: false,
      message: 'socket hang up',
      uncertain: true,
    });
  });
});

describe('isWithinStripeChargeIdempotencyWindow', () => {
  const nowMs = Date.parse('2026-11-15T20:00:00.000Z');

  it('allows an attempt exactly 20 hours old', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(
        new Date(nowMs - STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS),
        nowMs,
      ),
    ).toBe(true);
  });

  it('allows an attempt one millisecond inside the 20-hour window', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(
        new Date(nowMs - STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS + 1),
        nowMs,
      ),
    ).toBe(true);
  });

  it('rejects an attempt one millisecond outside the 20-hour window', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(
        new Date(nowMs - STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS - 1),
        nowMs,
      ),
    ).toBe(false);
  });

  it('allows an attempt timestamp exactly equal to now', () => {
    expect(isWithinStripeChargeIdempotencyWindow(new Date(nowMs), nowMs)).toBe(
      true,
    );
  });

  it('rejects an attempt one millisecond in the future', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(new Date(nowMs + 1), nowMs),
    ).toBe(false);
  });

  it('rejects an attempt substantially in the future', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(
        new Date(nowMs + 24 * 60 * 60 * 1000),
        nowMs,
      ),
    ).toBe(false);
  });

  it('rejects an invalid Date', () => {
    expect(isWithinStripeChargeIdempotencyWindow(new Date(NaN), nowMs)).toBe(
      false,
    );
  });

  it('rejects a non-finite nowMs', () => {
    expect(
      isWithinStripeChargeIdempotencyWindow(new Date(nowMs), Number.NaN),
    ).toBe(false);
    expect(
      isWithinStripeChargeIdempotencyWindow(
        new Date(nowMs),
        Number.POSITIVE_INFINITY,
      ),
    ).toBe(false);
  });
});

describe('card refund amount', () => {
  it('returns the full customer charge when the only line is returned', () => {
    expect(
      cardRefundAmount({ paymentAmount: 58.99, subtotal: 50, unitPrice: 50, quantity: 1 }),
    ).toBe(58.99);
  });

  it('returns one line share when other lines stay', () => {
    expect(
      cardRefundAmount({ paymentAmount: 58.99, subtotal: 50, unitPrice: 25, quantity: 1 }),
    ).toBe(29.5);
  });
});
