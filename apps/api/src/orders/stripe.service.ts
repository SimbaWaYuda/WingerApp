import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { cardCheckoutMode } from './checkout-mode';

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

export type CardRefundResult =
  | { ok: true; refundId: string }
  | { ok: false; message: string };

/**
 * Share of the customer charge for a returned line, in payment currency.
 * Tax and delivery are split by the line's share of the settlement subtotal,
 * so returning every line refunds the charge and returning one line does not.
 */
export function cardRefundAmount(params: {
  paymentAmount: number;
  subtotal: number;
  unitPrice: number;
  quantity: number;
}): number {
  const payment = Number(params.paymentAmount);
  const subtotal = Number(params.subtotal);
  const returned = Number(params.unitPrice) * Number(params.quantity);
  if (!(payment > 0) || !(subtotal > 0) || !(returned > 0)) return 0;
  const share = Math.min(returned / subtotal, 1);
  return Math.round(payment * share * 100) / 100;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  readonly checkoutMode: 'demo' | 'test' | 'live';

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
    this.checkoutMode = cardCheckoutMode(key);
    if (this.checkoutMode !== 'demo') {
      this.stripe = new Stripe(key, {
        apiVersion: '2025-02-24.acacia',
      });
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
          payment_method_types: ['card'],
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

  /**
   * Refunds part of a card PaymentIntent. The idempotency key must stay
   * stable for one return so a retry cannot refund the customer twice.
   */
  async refundCardCharge(params: {
    paymentIntentId: string;
    amount: number;
    idempotencyKey: string;
    orderId: string;
    returnRequestId: string;
  }): Promise<CardRefundResult> {
    if (!this.stripe) {
      return { ok: false, message: 'Stripe is not configured' };
    }
    const amountCents = Math.round(params.amount * 100);
    if (amountCents <= 0) {
      return { ok: false, message: 'Refund amount must be greater than zero' };
    }
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: params.paymentIntentId,
          amount: amountCents,
          metadata: {
            orderId: params.orderId,
            returnRequestId: params.returnRequestId,
          },
        },
        { idempotencyKey: params.idempotencyKey },
      );
      if (refund.status === 'failed' || refund.status === 'canceled') {
        return { ok: false, message: `Stripe refund ${refund.status}` };
      }
      return { ok: true, refundId: refund.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stripe refund failed';
      this.logger.warn(`Stripe refund failed: ${message}`);
      return { ok: false, message };
    }
  }

  /** Connect payouts run only against the test secret. Live charges are refused. */
  connectTestReady(): boolean {
    return this.checkoutMode === 'test' && this.stripe != null;
  }

  async createExpressAccount(params: {
    email: string;
    supplierId: string;
  }): Promise<{ id: string }> {
    this.assertConnectTest();
    const country = (process.env.STRIPE_CONNECT_COUNTRY || 'US').trim().toUpperCase() || 'US';
    const account = await this.stripe!.accounts.create({
      type: 'express',
      country,
      email: params.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      metadata: { supplierId: params.supplierId },
    });
    return { id: account.id };
  }

  async createAccountLink(params: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    this.assertConnectTest();
    const link = await this.stripe!.accountLinks.create({
      account: params.accountId,
      refresh_url: params.refreshUrl,
      return_url: params.returnUrl,
      type: 'account_onboarding',
    });
    return { url: link.url };
  }

  async retrieveConnectAccount(accountId: string): Promise<{
    payoutsEnabled: boolean;
    chargesEnabled: boolean;
    detailsSubmitted: boolean;
  }> {
    this.assertConnectTest();
    const account = await this.stripe!.accounts.retrieve(accountId);
    return {
      payoutsEnabled: account.payouts_enabled === true,
      chargesEnabled: account.charges_enabled === true,
      detailsSubmitted: account.details_submitted === true,
    };
  }

  async createSupplierTransfer(params: {
    amountCents: number;
    currency: string;
    destinationAccountId: string;
    sourceChargeId: string;
    idempotencyKey: string;
    orderItemId: string;
    supplierId: string;
  }): Promise<{ id: string }> {
    this.assertConnectTest();
    const transfer = await this.stripe!.transfers.create(
      {
        amount: params.amountCents,
        currency: params.currency.toLowerCase(),
        destination: params.destinationAccountId,
        source_transaction: params.sourceChargeId,
        metadata: {
          orderItemId: params.orderItemId,
          supplierId: params.supplierId,
        },
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: transfer.id };
  }

  async chargeBalanceForPaymentIntent(paymentIntentId: string): Promise<{
    chargeId: string;
    currency: string;
    amountMinor: number;
  } | null> {
    this.assertConnectTest();
    const intent = await this.stripe!.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.balance_transaction'],
    });
    const charge = intent.latest_charge;
    if (!charge || typeof charge === 'string') return null;
    const balance = charge.balance_transaction;
    if (!balance || typeof balance === 'string') return null;
    if (!balance.currency || !(balance.amount > 0)) return null;
    return {
      chargeId: charge.id,
      currency: balance.currency,
      amountMinor: balance.amount,
    };
  }

  async chargeIdForPaymentIntent(paymentIntentId: string): Promise<string | null> {
    this.assertConnectTest();
    const intent = await this.stripe!.paymentIntents.retrieve(paymentIntentId);
    const charge = intent.latest_charge;
    if (!charge) return null;
    return typeof charge === 'string' ? charge : charge.id;
  }

  async reverseSupplierTransfer(params: {
    transferId: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    this.assertConnectTest();
    const reversal = await this.stripe!.transfers.createReversal(
      params.transferId,
      {},
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: reversal.id };
  }

  private assertConnectTest(): void {
    if (!this.connectTestReady()) {
      throw new Error('Stripe payouts stay in test mode');
    }
  }
}
