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
        metadata: expect.objectContaining({ orderId: 'ord-1' }),
      }),
      { idempotencyKey: 'winger-charge-ord-1' },
    );
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
        metadata: { orderId: 'ord-1', returnRequestId: 'ret-1' },
      }),
      { idempotencyKey: 'winger-refund-ret-1' },
    );
  });

  it('reports a Stripe refund failure without throwing', async () => {
    const service = new StripeService();
    service.bindForTests(
      { refunds: { create: jest.fn().mockRejectedValue(new Error('Charge already refunded')) } } as never,
      'test',
    );

    const result = await service.refundCardCharge({
      paymentIntentId: 'pi_1',
      amount: 10,
      idempotencyKey: 'winger-refund-ret-1',
      orderId: 'ord-1',
      returnRequestId: 'ret-1',
    });

    expect(result).toEqual({ ok: false, message: 'Charge already refunded' });
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
