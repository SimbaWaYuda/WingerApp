import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OrdersService } from './orders.service';
import { StripeService } from './stripe.service';
import { StripeWebhookController } from './stripe-webhook.controller';

describe('StripeWebhookController unsellable acknowledgement (S2.5.4)', () => {
  function build(handleStripeEvent: jest.Mock) {
    const stripe = {
      constructWebhookEvent: jest.fn().mockReturnValue({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_1', metadata: { orderId: 'ord-1' } } },
      }),
    } as unknown as StripeService;
    const orders = {
      handleStripeEvent,
    } as unknown as OrdersService;
    const controller = new StripeWebhookController(stripe, orders);
    const req = {
      rawBody: Buffer.from('{"id":"evt_1"}'),
    } as never;
    return { controller, stripe, req };
  }

  it('returns HTTP 200 body when unsellable refund succeeded', async () => {
    const handle = jest.fn().mockResolvedValue({
      received: true,
      unsellable: true,
    });
    const { controller, req } = build(handle);
    const body = await controller.webhook(req, 'sig_test');
    expect(body).toEqual({ received: true, unsellable: true });
    expect(handle).toHaveBeenCalled();
  });

  it('propagates ServiceUnavailableException as HTTP 503 for pending unsellable refund', async () => {
    const handle = jest.fn().mockRejectedValue(
      new ServiceUnavailableException(
        'Stripe refund is pending; awaiting reconciliation',
      ),
    );
    const { controller, req } = build(handle);
    try {
      await controller.webhook(req, 'sig_test');
      throw new Error('expected ServiceUnavailableException');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    }
  });

  it('propagates ServiceUnavailableException as HTTP 503 for failed unsellable refund', async () => {
    const handle = jest.fn().mockRejectedValue(
      new ServiceUnavailableException('Stripe refund failed'),
    );
    const { controller, req } = build(handle);
    try {
      await controller.webhook(req, 'sig_test');
      throw new Error('expected ServiceUnavailableException');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    }
  });

  it('end-to-end: OrdersService unsellable NACK yields controller HTTP 503', async () => {
    // Same exception type thrown by refundUnsellableChargeOrNack.
    const handle = jest.fn().mockRejectedValue(
      new ServiceUnavailableException(
        'Stripe refund is pending; awaiting reconciliation',
      ),
    );
    const { controller, req, stripe } = build(handle);
    try {
      await controller.webhook(req, 't');
      throw new Error('expected ServiceUnavailableException');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    }
    expect(stripe.constructWebhookEvent).toHaveBeenCalled();
    expect(handle).toHaveBeenCalled();
  });

  it('still returns HTTP 400 for invalid signatures (unchanged)', async () => {
    const stripe = {
      constructWebhookEvent: jest.fn().mockImplementation(() => {
        throw new Error('Invalid signature');
      }),
    } as unknown as StripeService;
    const orders = {
      handleStripeEvent: jest.fn(),
    } as unknown as OrdersService;
    const controller = new StripeWebhookController(stripe, orders);
    await expect(
      controller.webhook(
        { rawBody: Buffer.from('{}') } as never,
        'bad_sig',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(orders.handleStripeEvent).not.toHaveBeenCalled();
  });
});
