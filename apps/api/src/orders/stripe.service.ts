import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

export type ChargeResult = {
  mode: 'demo' | 'stripe';
  status: 'paid' | 'failed';
  paymentIntentId?: string;
  message: string;
};

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    this.stripe = key
      ? new Stripe(key, {
          apiVersion: '2025-02-24.acacia',
        })
      : null;
    if (!this.stripe) {
      this.logger.log('STRIPE_SECRET_KEY not set — checkout uses demo payment');
    }
  }

  get configured(): boolean {
    return this.stripe != null;
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
          mode: 'stripe',
          status: 'paid',
          paymentIntentId: intent.id,
          message: 'Stripe payment succeeded',
        };
      }

      return {
        mode: 'stripe',
        status: 'failed',
        paymentIntentId: intent.id,
        message: `Stripe payment status: ${intent.status}`,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe charge failed';
      this.logger.warn(`Stripe charge failed: ${message}`);
      return {
        mode: 'stripe',
        status: 'failed',
        message,
      };
    }
  }
}
