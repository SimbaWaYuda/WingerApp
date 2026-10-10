import { StripeService } from './stripe.service';

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
});
