import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

export type ChargeResult = {
  mode: 'demo' | 'test' | 'live';
  status: 'paid' | 'failed';
  paymentIntentId?: string;
  message: string;
};

export type PaymentIntentEvent = {
  id?: string;
  type: string;
  livemode: boolean;
  data: {
    object: {
      id: string;
      metadata?: Record<string, string> | null;
    };
  };
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  readonly checkoutMode: 'demo' | 'test' | 'live';

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
    if (key.startsWith('sk_test_') || key.startsWith('sk_live_')) {
      this.stripe = new Stripe(key, {
        apiVersion: '2025-02-24.acacia',
      });
      this.checkoutMode = key.startsWith('sk_live_') ? 'live' : 'test';
    } else {
      this.stripe = null;
      this.checkoutMode = 'demo';
      this.logger.log('STRIPE_SECRET_KEY not set — checkout uses demo payment');
    }
  }

  get configured(): boolean {
    return this.checkoutMode !== 'demo';
  }

  /** Test hook. Production always uses the key from the environment. */
  bindForTests(client: Stripe | null, mode: 'demo' | 'test' | 'live') {
    Object.assign(this, { stripe: client, checkoutMode: mode });
  }

  async chargeOrder(params: {
    amountCents: number;
    currency: string;
    orderId: string;
    orderDisplayId: string;
    customerEmail: string;
    /** Stable for this order so a retry returns the same PaymentIntent. */
    idempotencyKey: string;
    /** Stripe PaymentMethod id (pm_...). The card number never reaches this API. */
    paymentMethodId?: string;
  }): Promise<ChargeResult> {
    if (!this.stripe) {
      return {
        mode: 'demo',
        status: 'paid',
        message: 'Demo payment accepted (no STRIPE_SECRET_KEY)',
      };
    }

    const paymentMethodId = params.paymentMethodId?.trim() ?? '';
    if (!/^pm_[A-Za-z0-9_]+$/.test(paymentMethodId)) {
      return {
        mode: this.checkoutMode,
        status: 'failed',
        message: 'Enter a card to pay',
      };
    }

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: params.amountCents,
          currency: params.currency.toLowerCase(),
          payment_method: paymentMethodId,
          confirm: true,
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never',
          },
          metadata: {
            orderId: params.orderId,
            orderDisplayId: params.orderDisplayId,
            customerEmail: params.customerEmail,
          },
          receipt_email: params.customerEmail,
        },
        { idempotencyKey: params.idempotencyKey },
      );

      if (intent.status === 'succeeded') {
        return {
          mode: this.checkoutMode,
          status: 'paid',
          paymentIntentId: intent.id,
          message: 'Stripe payment succeeded',
        };
      }

      return {
        mode: this.checkoutMode,
        status: 'failed',
        paymentIntentId: intent.id,
        message: `Stripe payment status: ${intent.status}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe charge failed';
      this.logger.warn(`Stripe charge failed: ${message}`);
      return {
        mode: this.checkoutMode,
        status: 'failed',
        message,
      };
    }
  }

  /**
   * Verifies the Stripe-Signature header against the raw request body.
   * Refuses the event when the webhook secret is not configured.
   */
  constructWebhookEvent(rawBody: Buffer, signature: string | undefined): PaymentIntentEvent {
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
    if (!secret || !this.stripe) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not configured');
    }
    if (!signature) {
      throw new Error('Missing Stripe signature');
    }
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
    ) as PaymentIntentEvent;
  }
}
