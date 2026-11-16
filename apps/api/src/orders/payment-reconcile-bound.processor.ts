import { Injectable, Logger } from '@nestjs/common';
import {
  PaymentReconcileManualReviewReason,
  PaymentStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OrdersService } from './orders.service';
import {
  PAYMENT_RECONCILE_MAX_CLAIMS,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import {
  paymentReconcileBackoffMs,
  PaymentReconcileWorkContext,
  PaymentReconcileWorker,
} from './payment-reconcile.worker';
import { assertStripePaymentIntentMatchesOrder } from './stripe-payment-intent-identity';
import { StripeService } from './stripe.service';

const SOFT_STATUSES = new Set([
  'processing',
  'requires_action',
  'requires_payment_method',
  'requires_confirmation',
  'requires_capture',
]);

/**
 * Bound PaymentIntent reconciliation processor (S2.6.20.9 / 9b).
 * Retrieves an existing PI only — never creates, confirms, or searches.
 *
 * Wires itself onto PaymentReconcileWorker in the constructor so the processor
 * is registered before the worker's onModuleInit activation check.
 */
@Injectable()
export class PaymentReconcileBoundProcessor {
  private readonly logger = new Logger(PaymentReconcileBoundProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly lease: PaymentReconcileLeaseService,
    private readonly stripe: StripeService,
    worker: PaymentReconcileWorker,
  ) {
    worker.setProcessor((ctx) => this.process(ctx));
  }

  async process(ctx: PaymentReconcileWorkContext): Promise<void> {
    if (!ctx.canApplyTerminal()) return;

    const order = await this.prisma.order.findUnique({
      where: { id: ctx.order.id },
      select: {
        id: true,
        customerId: true,
        status: true,
        paymentStatus: true,
        paymentMode: true,
        stripePaymentIntentId: true,
        paymentAmount: true,
        paymentCurrency: true,
        currency: true,
        total: true,
      },
    });

    if (!order) {
      this.logger.warn(
        `Bound processor: order ${ctx.order.id} missing on re-read`,
      );
      return;
    }

    if (order.paymentStatus !== PaymentStatus.PENDING) {
      // Webhook or another path already terminal — release via worker finally.
      return;
    }

    const mode = order.paymentMode.trim().toLowerCase();
    if (mode !== 'test' && mode !== 'live') {
      this.logger.warn(
        `Bound processor skipped order ${order.id}: paymentMode ${order.paymentMode}`,
      );
      return;
    }

    const claimedPi = (ctx.order.stripePaymentIntentId ?? '').trim();
    const storedPi = (order.stripePaymentIntentId ?? '').trim();

    // Bound ID changed between claim snapshot and re-read — never retrieve either id.
    if (
      claimedPi.startsWith('pi_') &&
      storedPi.startsWith('pi_') &&
      claimedPi !== storedPi
    ) {
      await this.escalateIdentityMismatch(ctx, 'bound_pi_changed_after_claim');
      return;
    }

    if (!storedPi.startsWith('pi_')) {
      // Locked unbound/malformed policy: no Stripe I/O; schedule or exhaust.
      this.logger.warn(
        `Bound processor: order ${order.id} missing/malformed PaymentIntent id; no Stripe I/O`,
      );
      await this.handleNonTerminal(ctx, 'unbound_or_malformed_pi');
      return;
    }

    // Retrieve only the exact bound id from the fresh re-read (matches claim when both set).
    const retrieveId = storedPi;

    if (!ctx.canApplyTerminal()) return;

    const retrieved =
      await this.stripe.retrievePaymentIntentForWebhook(retrieveId);

    if (!ctx.canApplyTerminal()) return;

    if (!retrieved.ok) {
      // Network / API / 429 — approved backoff only (no Retry-After parsing).
      await this.handleNonTerminal(ctx, 'stripe_retrieve_error');
      return;
    }

    if (retrieved.intent.id !== retrieveId) {
      await this.escalateIdentityMismatch(ctx, 'retrieved_id_mismatch');
      return;
    }

    // Re-validate against the fresh order row (identity uses stored bind).
    const status = retrieved.intent.status.trim().toLowerCase();

    if (status === 'succeeded') {
      const validated = assertStripePaymentIntentMatchesOrder({
        order,
        intent: retrieved.intent,
        requireSucceeded: true,
      });
      if (!validated.ok) {
        await this.escalateIdentityMismatch(ctx, validated.code);
        return;
      }
      if (!ctx.canApplyTerminal()) return;
      await this.orders.applyWorkerCardSuccess({
        orderId: order.id,
        customerId: order.customerId,
        statusHint: order.status,
        paymentIntentId: retrieved.intent.id,
        mode: validated.paymentMode,
        leaseOwner: ctx.order.leaseOwner,
      });
      return;
    }

    const identity = assertStripePaymentIntentMatchesOrder({
      order,
      intent: retrieved.intent,
      requireSucceeded: false,
    });
    if (!identity.ok) {
      await this.escalateIdentityMismatch(ctx, identity.code);
      return;
    }

    if (status === 'canceled') {
      if (!ctx.canApplyTerminal()) return;
      await this.orders.failWorkerCardOrder({
        orderId: order.id,
        paymentMode: identity.paymentMode,
        paymentIntentId: retrieved.intent.id,
        actorUserId: order.customerId,
        leaseOwner: ctx.order.leaseOwner,
      });
      return;
    }

    if (SOFT_STATUSES.has(status) || status.length === 0) {
      await this.handleNonTerminal(ctx, `status:${status || 'empty'}`);
      return;
    }

    await this.handleNonTerminal(ctx, `status_unknown:${status}`);
  }

  private async escalateIdentityMismatch(
    ctx: PaymentReconcileWorkContext,
    detail: string,
  ): Promise<void> {
    if (!ctx.canApplyTerminal()) return;
    this.logger.warn(
      `Identity mismatch for order ${ctx.order.id} (${detail}); marking IDENTITY_MISMATCH`,
    );
    await this.lease.markManualReview({
      orderId: ctx.order.id,
      leaseOwner: ctx.order.leaseOwner,
      reason: PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
    });
  }

  private async handleNonTerminal(
    ctx: PaymentReconcileWorkContext,
    reason: string,
  ): Promise<void> {
    if (!ctx.canApplyTerminal()) return;

    if (ctx.order.attemptCount >= PAYMENT_RECONCILE_MAX_CLAIMS) {
      this.logger.warn(
        `Retry exhausted for order ${ctx.order.id} after claim ${ctx.order.attemptCount} (${reason})`,
      );
      await this.lease.markManualReview({
        orderId: ctx.order.id,
        leaseOwner: ctx.order.leaseOwner,
        reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
      });
      return;
    }

    const delayMs = paymentReconcileBackoffMs(ctx.order.attemptCount);
    const nextAt = new Date(Date.now() + delayMs);
    const scheduled = await this.lease.scheduleNextAttempt({
      orderId: ctx.order.id,
      leaseOwner: ctx.order.leaseOwner,
      nextAt,
    });
    if (!scheduled) {
      this.logger.warn(
        `scheduleNextAttempt no-op for ${ctx.order.id} (${reason}); lease likely lost`,
      );
    }
  }
}

/** Narrow adapter for PaymentReconcileWorker.setProcessor. */
export function boundPaymentIntentProcessor(
  processor: PaymentReconcileBoundProcessor,
): (ctx: PaymentReconcileWorkContext) => Promise<void> {
  return (ctx) => processor.process(ctx);
}
