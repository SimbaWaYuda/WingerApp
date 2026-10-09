import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

export type ChargeResult = {
  mode: 'demo' | 'test' | 'live';
  status: 'paid' | 'failed';
  paymentIntentId?: string;
  message: string;
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

  async chargeOrder(params: {
    amountCents: number;
    currency: string;
    orderDisplayId: string;
    customerEmail: string;
  }): Promise<ChargeResult> {
    if (!this.stripe) {
      return {
        mode: 'demo',
        status: 'paid',
        message: 'Demo payment accepted (no STRIPE_SECRET_KEY)',
      };
    }

    try {
      const intent = await this.stripe.paymentIntents.create({
        amount: params.amountCents,
        currency: params.currency.toLowerCase(),
        payment_method: 'pm_card_visa',
        confirm: true,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
        metadata: {
          orderDisplayId: params.orderDisplayId,
          customerEmail: params.customerEmail,
        },
        receipt_email: params.customerEmail,
      });

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
}
