import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  canInsertNextSubmissionVersion,
  isRefundAttemptV1Enabled,
  LatestSubmissionView,
  operationKeyForCancelRemaining,
  operationKeyForLineCancel,
  operationKeyForOrderCancel,
  operationKeyForReturn,
  operationKeyForUnsellable,
  RefundAttemptKindName,
  requiresReconcileBeforeStripeCreate,
  stripeIdempotencyKeyForSubmission,
} from './refund-attempt.types';

/**
 * Phase 3 RefundAttempt orchestration (S2.0 skeleton).
 *
 * Responsibilities (full stages S2.1+):
 * - Create/load RefundAttempt by stable operationKey
 * - Manage versioned RefundAttemptSubmission rows and Stripe idempotency keys
 * - Reconcile uncertain Stripe outcomes before new submissions
 * - Apply refundedAmount + clawback once after Stripe success
 * - Track Connect reverse / unrecovered amounts
 *
 * S2.0: policy helpers only. Not injected into refund execution paths.
 * Stripe submit, reconcile, apply, Connect, and recovery are S2.1+.
 */
@Injectable()
export class RefundAttemptService {
  private readonly logger = new Logger(RefundAttemptService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** When false, OrdersService must keep using legacy refundPaidCard paths. */
  isV1Enabled(): boolean {
    return isRefundAttemptV1Enabled();
  }

  operationKey(
    kind: RefundAttemptKindName,
    id: string,
  ): string {
    switch (kind) {
      case 'RETURN':
        return operationKeyForReturn(id);
      case 'ORDER_CANCEL':
        return operationKeyForOrderCancel(id);
      case 'LINE_CANCEL':
        return operationKeyForLineCancel(id);
      case 'CANCEL_REMAINING':
        return operationKeyForCancelRemaining(id);
      case 'UNSELLABLE':
        return operationKeyForUnsellable(id);
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  }

  stripeIdempotencyKey(operationKey: string, version: number): string {
    return stripeIdempotencyKeyForSubmission(operationKey, version);
  }

  canOpenNextSubmission(latest: LatestSubmissionView | null) {
    return canInsertNextSubmissionVersion(latest);
  }

  mustReconcileBeforeCreate(input: {
    outcome: LatestSubmissionView['outcome'];
    submittedAt: Date | null;
    now?: Date;
  }): boolean {
    return requiresReconcileBeforeStripeCreate(input);
  }

  /**
   * S2.1+: create or load attempt + ensure version-1 submission.
   * Unwired in S2.0 — do not call from OrdersService yet.
   */
  async ensureAttemptForOperation(_params: {
    kind: RefundAttemptKindName;
    operationKey: string;
    orderId: string;
    actorUserId: string;
    stripePaymentIntentId: string;
    amount: number;
    amountCents: number;
    currency: string;
  }): Promise<never> {
    this.logger.warn('ensureAttemptForOperation is not implemented until S2.1');
    throw new Error('RefundAttemptService.ensureAttemptForOperation: S2.1 not started');
  }

  /**
   * S2.1+: reconcile PaymentIntent refunds before create when UNKNOWN or ≥24h.
   */
  async reconcileSubmission(_params: {
    refundAttemptId: string;
    submissionId: string;
  }): Promise<never> {
    this.logger.warn('reconcileSubmission is not implemented until S2.1');
    throw new Error('RefundAttemptService.reconcileSubmission: S2.1 not started');
  }

  /**
   * S2.2+: apply shipment.refundedAmount + clawback in one short transaction.
   */
  async applySuccessfulRefund(_params: {
    refundAttemptId: string;
  }): Promise<never> {
    this.logger.warn('applySuccessfulRefund is not implemented until S2.2');
    throw new Error('RefundAttemptService.applySuccessfulRefund: S2.2 not started');
  }

  /** Prisma is injected for S2.1+; unused in S2.0 skeleton. */
  get db(): PrismaService {
    return this.prisma;
  }
}
