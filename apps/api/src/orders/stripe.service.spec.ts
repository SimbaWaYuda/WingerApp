import { cardRefundAmount, StripeService } from './stripe.service';

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
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({ ok: true, refundId: 're_1' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 2950,
        metadata: { orderId: 'ord-1', reason: 'return', returnRequestId: 'ret-1' },
      }),
      { idempotencyKey: 'winger-refund-ret-1' },
    );
  });

  it('refunds a cancelled order with a stable cancel key', async () => {
    const create = jest.fn().mockResolvedValue({ id: 're_cancel', status: 'succeeded' });
    const service = new StripeService();
    service.bindForTests({ refunds: { create } } as never, 'test');

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 58.99,
      idempotencyKey: 'winger-cancel-ord-1',
      orderId: 'ord-1',
      reason: 'cancel',
    });

    expect(result).toEqual({ ok: true, refundId: 're_cancel' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_intent: 'pi_1',
        amount: 5899,
        metadata: { orderId: 'ord-1', reason: 'cancel' },
      }),
      { idempotencyKey: 'winger-cancel-ord-1' },
    );
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
      idempotencyKey: 'winger-cancel-ord-1',
      orderId: 'ord-1',
      reason: 'cancel',
    });

    expect(result).toEqual({ ok: true, refundId: 'already_refunded' });
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
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({ ok: false, message: 'insufficient funds' });
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
