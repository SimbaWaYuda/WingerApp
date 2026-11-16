import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import { cardCheckoutMode } from './checkout-mode';
import { StripeAmountError, toStripeAmountMinor } from './stripe-amount';

export type ChargeResult = {
  mode: 'demo' | 'test' | 'live';
  /**
   * paid — Stripe confirmed success.
   * failed — definitive decline/cancel (safe to restore stock).
   * uncertain — transport loss or non-terminal PI status; do not restore stock.
   */
  status: 'paid' | 'failed' | 'uncertain';
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
  | {
      ok: true;
      refundId: string;
      /** Stripe refund.status — callers must inspect; ok:true alone is not success. */
      status: string | null;
    }
  | {
      ok: false;
      message: string;
      /**
       * True when the create may have reached Stripe (timeout/network).
       * Callers must not treat this as FAILED_TERMINAL.
       */
      uncertain?: boolean;
      /** Present when Stripe returned a definitive failed/canceled Refund object. */
      refundId?: string;
      status?: string | null;
    };

/** Normalized Stripe refund fields used by RefundAttempt reconciliation (S2.1). */
export type StripeRefundListItem = {
  id: string;
  amount: number;
  currency: string;
  status: string | null;
  failureReason: string | null;
  metadata: Record<string, string>;
};

export type ListRefundsResult =
  | { ok: true; refunds: StripeRefundListItem[]; exhausted: true }
  | {
      ok: false;
      message: string;
      exhausted: false;
      refunds: StripeRefundListItem[];
    };

export type CreateRefundForAttemptResult =
  | {
      ok: true;
      refund: {
        id: string;
        status: string | null;
        failureReason: string | null;
      };
    }
  | {
      ok: false;
      message: string;
      /** True when the create may have reached Stripe (must reconcile, never blind retry-create). */
      uncertain: boolean;
    };

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

      return classifyPaymentIntent(intent, this.checkoutMode);
    } catch (error) {
      return this.uncertainChargeFromError(error, 'Stripe charge failed');
    }
  }

  /**
   * Confirm an existing PaymentIntent with a payment method.
   * Stripe I/O only — callers must not hold a DB transaction open.
   */
  async confirmPaymentIntent(params: {
    paymentIntentId: string;
    paymentMethodId: string;
  }): Promise<ChargeResult> {
    if (!this.stripe) {
      return {
        mode: 'demo',
        status: 'uncertain',
        paymentIntentId: params.paymentIntentId,
        message: 'Stripe is not configured',
      };
    }

    const paymentIntentId = params.paymentIntentId.trim();
    if (!paymentIntentId.startsWith('pi_')) {
      return {
        mode: this.checkoutMode,
        status: 'uncertain',
        message: 'Invalid PaymentIntent id',
      };
    }

    const paymentMethodId = params.paymentMethodId?.trim() ?? '';
    if (!/^pm_[A-Za-z0-9_]+$/.test(paymentMethodId)) {
      return {
        mode: this.checkoutMode,
        status: 'uncertain',
        paymentIntentId,
        message: 'Enter a card to pay',
      };
    }

    try {
      const intent = await this.stripe.paymentIntents.confirm(paymentIntentId, {
        payment_method: paymentMethodId,
      });
      return classifyPaymentIntent(intent, this.checkoutMode);
    } catch (error) {
      return this.uncertainChargeFromError(error, 'Stripe confirm failed');
    }
  }

  /**
   * Fresh PaymentIntent status for webhook/reconcile decisions.
   * Stripe I/O only — callers must not hold a DB transaction open.
   */
  async retrievePaymentIntentStatus(
    paymentIntentId: string,
  ): Promise<
    | { ok: true; id: string; status: string }
    | { ok: false; message: string }
  > {
    const id = paymentIntentId.trim();
    if (!id.startsWith('pi_')) {
      return { ok: false, message: 'Invalid PaymentIntent id' };
    }
    if (!this.stripe) {
      return { ok: false, message: 'Stripe is not configured' };
    }
    try {
      const intent = await this.stripe.paymentIntents.retrieve(id);
      return { ok: true, id: intent.id, status: String(intent.status ?? '') };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe retrieve failed';
      this.logger.warn(`Stripe PaymentIntent retrieve failed: ${message}`);
      return { ok: false, message };
    }
  }

  private uncertainChargeFromError(
    error: unknown,
    fallbackMessage: string,
  ): ChargeResult {
    const message =
      error instanceof Error ? error.message : fallbackMessage;
    const paymentIntentId = paymentIntentIdFromStripeError(error);
    if (isUncertainStripeNetworkError(error)) {
      this.logger.warn(`Stripe charge outcome uncertain: ${message}`);
      return {
        mode: this.checkoutMode,
        status: 'uncertain',
        paymentIntentId,
        message,
      };
    }
    // Card declines, open PIs, and any ambiguous Stripe error: do not restore stock.
    // Only a verified canceled PaymentIntent status is a definitive charge failure.
    this.logger.warn(`Stripe charge outcome uncertain: ${message}`);
    return {
      mode: this.checkoutMode,
      status: 'uncertain',
      paymentIntentId,
      message,
    };
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
   * Refunds part or all of a card PaymentIntent. The idempotency key must stay
   * stable for one cancel, return, or unsellable recovery so a retry cannot
   * refund the customer twice.
   */
  async refundCardCharge(params: {
    paymentIntentId: string;
    amount: number;
    /** Major-unit currency for amount (USD/TZS). Used only for conversion. */
    currency: string;
    idempotencyKey: string;
    orderId: string;
    returnRequestId?: string;
    reason?: 'return' | 'cancel' | 'unsellable' | 'line_cancel';
  }): Promise<CardRefundResult> {
    if (!this.stripe) {
      return { ok: false, message: 'Stripe is not configured' };
    }
    let amountCents: number;
    try {
      amountCents = toStripeAmountMinor(params.amount, params.currency);
    } catch (error) {
      const message =
        error instanceof StripeAmountError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Refund amount must be greater than zero';
      return { ok: false, message };
    }
    const reason =
      params.reason ?? (params.returnRequestId ? 'return' : 'cancel');
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: params.paymentIntentId,
          amount: amountCents,
          metadata: {
            orderId: params.orderId,
            reason,
            ...(params.returnRequestId
              ? { returnRequestId: params.returnRequestId }
              : {}),
          },
        },
        { idempotencyKey: params.idempotencyKey },
      );
      if (refund.status === 'failed' || refund.status === 'canceled') {
        return {
          ok: false,
          message: `Stripe refund ${refund.status}`,
          refundId: refund.id,
          status: refund.status,
        };
      }
      return {
        ok: true,
        refundId: refund.id,
        status: refund.status ?? null,
      };
    } catch (error) {
      if (isAlreadyRefunded(error)) {
        // Charge already refunded is definitive success for ledger completion.
        return { ok: true, refundId: 'already_refunded', status: 'succeeded' };
      }
      const message = error instanceof Error ? error.message : 'Stripe refund failed';
      this.logger.warn(`Stripe refund failed: ${message}`);
      return {
        ok: false,
        message,
        uncertain: isUncertainStripeNetworkError(error),
      };
    }
  }

  /**
   * Lists every refund on a PaymentIntent (paginated to exhaustion).
   * Used by RefundAttempt reconcile — never call inside a DB transaction.
   */
  async listRefundsForPaymentIntent(
    paymentIntentId: string,
  ): Promise<ListRefundsResult> {
    if (!this.stripe) {
      return {
        ok: false,
        message: 'Stripe is not configured',
        exhausted: false,
        refunds: [],
      };
    }
    const refunds: StripeRefundListItem[] = [];
    try {
      let startingAfter: string | undefined;
      for (;;) {
        const page = await this.stripe.refunds.list({
          payment_intent: paymentIntentId,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        for (const refund of page.data) {
          refunds.push(normalizeStripeRefund(refund));
        }
        if (!page.has_more) {
          return { ok: true, refunds, exhausted: true };
        }
        const last = page.data[page.data.length - 1];
        if (!last?.id) {
          return {
            ok: false,
            message: 'Stripe refund list page missing cursor',
            exhausted: false,
            refunds,
          };
        }
        startingAfter = last.id;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe refund list failed';
      this.logger.warn(`Stripe refund list failed: ${message}`);
      return { ok: false, message, exhausted: false, refunds };
    }
  }

  /**
   * V1 RefundAttempt submission create. Includes operationKey in metadata.
   * Does not change legacy refundCardCharge behaviour.
   * Never call inside a DB transaction.
   */
  async createRefundForAttempt(params: {
    paymentIntentId: string;
    amountCents: number;
    currency: string;
    orderId: string;
    operationKey: string;
    idempotencyKey: string;
    returnRequestId?: string | null;
  }): Promise<CreateRefundForAttemptResult> {
    if (!this.stripe) {
      return {
        ok: false,
        message: 'Stripe is not configured',
        uncertain: false,
      };
    }
    if (!(params.amountCents > 0)) {
      return {
        ok: false,
        message: 'Refund amount must be greater than zero',
        uncertain: false,
      };
    }
    try {
      const refund = await this.stripe.refunds.create(
        {
          payment_intent: params.paymentIntentId,
          amount: params.amountCents,
          currency: params.currency.toLowerCase(),
          metadata: {
            orderId: params.orderId,
            operationKey: params.operationKey,
            ...(params.returnRequestId
              ? { returnRequestId: params.returnRequestId }
              : {}),
          },
        },
        { idempotencyKey: params.idempotencyKey },
      );
      return {
        ok: true,
        refund: {
          id: refund.id,
          status: refund.status ?? null,
          failureReason: refundFailureReason(refund),
        },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Stripe refund failed';
      this.logger.warn(`Stripe attempt refund failed: ${message}`);
      return { ok: false, message, uncertain: true };
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

function isAlreadyRefunded(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === 'charge_already_refunded') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return message.includes('already refunded');
}

/** Only `canceled` is a definitive closed-for-charging failure (Stripe.PaymentIntent.Status). */
function isCanceledPaymentIntentStatus(
  status: string | null | undefined,
): boolean {
  return (status ?? '').trim().toLowerCase() === 'canceled';
}

/** Map a retrieved/confirmed PaymentIntent into the shared ChargeResult contract. */
function classifyPaymentIntent(
  intent: { id: string; status?: string | null },
  mode: 'demo' | 'test' | 'live',
): ChargeResult {
  if (intent.status === 'succeeded') {
    return {
      mode,
      status: 'paid',
      paymentIntentId: intent.id,
      message: 'Stripe payment succeeded',
    };
  }
  if (isCanceledPaymentIntentStatus(intent.status)) {
    return {
      mode,
      status: 'failed',
      paymentIntentId: intent.id,
      message: `Stripe payment status: ${intent.status}`,
    };
  }
  return {
    mode,
    status: 'uncertain',
    paymentIntentId: intent.id,
    message: `Stripe payment status: ${intent.status}`,
  };
}

/** Conservative window for reusing `winger-charge-{orderId}` (Stripe idempotency retention). */
export const STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS = 20 * 60 * 60 * 1000;

export function isWithinStripeChargeIdempotencyWindow(
  attemptAt: Date,
  nowMs: number = Date.now(),
): boolean {
  if (!(attemptAt instanceof Date)) return false;
  const attemptMs = attemptAt.getTime();
  if (!Number.isFinite(attemptMs) || !Number.isFinite(nowMs)) return false;
  const elapsedMs = nowMs - attemptMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return false;
  return elapsedMs <= STRIPE_CHARGE_IDEMPOTENCY_WINDOW_MS;
}

/** Best-effort PaymentIntent id from a Stripe SDK error payload (never logs card data). */
function paymentIntentIdFromStripeError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { payment_intent?: unknown }).payment_intent;
  if (typeof direct === 'string' && direct.startsWith('pi_')) return direct;
  if (
    direct &&
    typeof direct === 'object' &&
    'id' in direct &&
    typeof (direct as { id: unknown }).id === 'string'
  ) {
    const id = (direct as { id: string }).id;
    if (id.startsWith('pi_')) return id;
  }
  const raw = (error as { raw?: { payment_intent?: unknown } }).raw;
  const nested = raw?.payment_intent;
  if (typeof nested === 'string' && nested.startsWith('pi_')) return nested;
  if (
    nested &&
    typeof nested === 'object' &&
    'id' in nested &&
    typeof (nested as { id: unknown }).id === 'string'
  ) {
    const id = (nested as { id: string }).id;
    if (id.startsWith('pi_')) return id;
  }
  return undefined;
}

/** Network/timeout/connection errors — may have reached Stripe; never treat as terminal. */
function isUncertainStripeNetworkError(error: unknown): boolean {
  const type =
    error && typeof error === 'object' && 'type' in error
      ? String((error as { type: unknown }).type)
      : '';
  if (
    type === 'StripeConnectionError' ||
    type === 'StripeAPIError' ||
    type === 'StripeRateLimitError'
  ) {
    return true;
  }
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === 'rate_limit' || code === 'lock_timeout') {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return /timeout|timed out|econnreset|econnrefused|socket hang up|network|temporarily unavailable|rate limit|503|502|504|429/.test(
    message,
  );
}

function normalizeStripeRefund(refund: {
  id: string;
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
  reason?: string | null;
  failure_reason?: string | null;
  metadata?: Stripe.Metadata | null;
}): StripeRefundListItem {
  const metadata: Record<string, string> = {};
  if (refund.metadata) {
    for (const [key, value] of Object.entries(refund.metadata)) {
      if (typeof value === 'string') metadata[key] = value;
    }
  }
  return {
    id: refund.id,
    amount: refund.amount ?? 0,
    currency: (refund.currency ?? '').toLowerCase(),
    status: refund.status ?? null,
    failureReason: refundFailureReason(refund),
    metadata,
  };
}

function refundFailureReason(refund: {
  failure_reason?: string | null;
  reason?: string | null;
  status?: string | null;
}): string | null {
  if (refund.failure_reason) return String(refund.failure_reason);
  if (refund.status === 'failed' || refund.status === 'canceled') {
    return refund.reason ? String(refund.reason) : refund.status;
  }
  return null;
}
