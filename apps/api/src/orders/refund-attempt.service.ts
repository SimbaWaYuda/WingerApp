import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  RefundAttemptKind,
  RefundAttemptStatus,
  RefundReconciliationResult,
  RefundSubmissionOutcome,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './stripe.service';
import {
  classifyRefundReconciliation,
  isFailedRefundStatus,
  isLiveRefundStatus,
  isSucceededRefundStatus,
  sanitizeRefundErrorDetail,
  type RefundFingerprint,
} from './refund-attempt.match';
import {
  canInsertNextSubmissionVersion,
  canRetryStripeCreateSameVersion,
  INFLIGHT_UNRESOLVED_REASON,
  isApplyEligibleStripeSuccess,
  isInFlightUncertainSubmission,
  isRefundAttemptV1Enabled,
  isUnresolvedClaimedStripeCreate,
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

type AttemptRow = {
  id: string;
  operationKey: string;
  kind: RefundAttemptKind;
  status: RefundAttemptStatus;
  orderId: string;
  returnRequestId: string | null;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amountCents: number;
  currency: string;
  lastError: string | null;
  investigationReason: string | null;
};

type SubmissionRow = {
  id: string;
  refundAttemptId: string;
  version: number;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
  reconciliationResult: RefundReconciliationResult;
  stripeRefundId: string | null;
  outcome: RefundSubmissionOutcome;
};

export type EnsureAttemptResult = {
  attempt: AttemptRow;
  submission: SubmissionRow;
};

export type ReconcileSubmissionResult = {
  attempt: AttemptRow;
  submission: SubmissionRow;
  classification:
    | 'MATCHED_LIVE'
    | 'MATCHED_FAILED'
    | 'NO_MATCH'
    | 'AMBIGUOUS'
    | 'INCOMPLETE'
    | 'UNRESOLVED_INFLIGHT'
    | 'OPENED_NEXT_VERSION'
    | 'STALE_SUBMISSION_IGNORED';
  openedSubmission?: SubmissionRow;
};

export type SubmitCurrentSubmissionResult = {
  attempt: AttemptRow;
  submission: SubmissionRow;
  created: boolean;
  blockedReason?: string;
};

/**
 * Phase 3 RefundAttempt orchestration (S2.1).
 * Stripe submit + reconcile only. Apply/clawback remain S2.2.
 * Not injected into OrdersService refund paths yet.
 */
@Injectable()
export class RefundAttemptService {
  private readonly logger = new Logger(RefundAttemptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  /** When false, OrdersService must keep using legacy refundPaidCard paths. */
  isV1Enabled(): boolean {
    return isRefundAttemptV1Enabled();
  }

  operationKey(kind: RefundAttemptKindName, id: string): string {
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
    stripeRefundId?: string | null;
    now?: Date;
  }): boolean {
    return requiresReconcileBeforeStripeCreate(input);
  }

  /**
   * Create or load RefundAttempt by operationKey and ensure an open submission.
   * Short DB work only — no Stripe calls.
   */
  async ensureAttemptForOperation(params: {
    kind: RefundAttemptKindName;
    operationKey: string;
    orderId: string;
    actorUserId: string;
    stripePaymentIntentId: string;
    amount: number;
    amountCents: number;
    currency: string;
    returnRequestId?: string | null;
    orderItemId?: string | null;
    orderShipmentId?: string | null;
    supplierId?: string | null;
    includeDelivery?: boolean;
  }): Promise<EnsureAttemptResult> {
    const currency = params.currency.toLowerCase();
    const kind = params.kind as RefundAttemptKind;

    const existing = await this.prisma.refundAttempt.findUnique({
      where: { operationKey: params.operationKey },
      include: {
        submissions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    if (existing) {
      if (existing.amountCents !== params.amountCents) {
        throw new Error(
          `RefundAttempt ${existing.operationKey} amountCents frozen at ${existing.amountCents}`,
        );
      }
      if (existing.currency.toLowerCase() !== currency) {
        throw new Error(
          `RefundAttempt ${existing.operationKey} currency frozen at ${existing.currency}`,
        );
      }
      if (existing.stripePaymentIntentId !== params.stripePaymentIntentId) {
        throw new Error(
          `RefundAttempt ${existing.operationKey} paymentIntent frozen`,
        );
      }

      const latest = existing.submissions[0] ?? null;
      if (!latest) {
        const createdSub = await this.insertSubmissionVersion(
          existing.id,
          params.operationKey,
          1,
        );
        return { attempt: asAttempt(existing), submission: createdSub };
      }
      const gate = canInsertNextSubmissionVersion(toLatestView(latest));
      if (gate.allowed && latest.outcome !== RefundSubmissionOutcome.PENDING) {
        const opened = await this.openNextSubmissionVersion(existing.id, latest);
        const attempt = await this.prisma.refundAttempt.findUniqueOrThrow({
          where: { id: existing.id },
        });
        return { attempt: asAttempt(attempt), submission: opened };
      }
      return { attempt: asAttempt(existing), submission: asSubmission(latest) };
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const attempt = await tx.refundAttempt.create({
        data: {
          operationKey: params.operationKey,
          kind,
          status: RefundAttemptStatus.PENDING,
          orderId: params.orderId,
          returnRequestId: params.returnRequestId ?? null,
          orderItemId: params.orderItemId ?? null,
          orderShipmentId: params.orderShipmentId ?? null,
          supplierId: params.supplierId ?? null,
          actorUserId: params.actorUserId,
          stripePaymentIntentId: params.stripePaymentIntentId,
          amount: new Prisma.Decimal(params.amount),
          amountCents: params.amountCents,
          currency,
          includeDelivery: params.includeDelivery ?? false,
        },
      });
      const submission = await tx.refundAttemptSubmission.create({
        data: {
          refundAttemptId: attempt.id,
          version: 1,
          stripeIdempotencyKey: stripeIdempotencyKeyForSubmission(
            params.operationKey,
            1,
          ),
          outcome: RefundSubmissionOutcome.PENDING,
          reconciliationResult: RefundReconciliationResult.NONE,
        },
      });
      return { attempt, submission };
    });

    return {
      attempt: asAttempt(created.attempt),
      submission: asSubmission(created.submission),
    };
  }

  /**
   * Reconcile a submission against Stripe refunds on the PaymentIntent.
   * Stripe list runs outside any DB transaction.
   */
  async reconcileSubmission(params: {
    refundAttemptId: string;
    submissionId: string;
  }): Promise<ReconcileSubmissionResult> {
    const prepared = await this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.refundAttemptId);
      const attempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: params.refundAttemptId },
      });
      const submission = await tx.refundAttemptSubmission.findUniqueOrThrow({
        where: { id: params.submissionId },
      });
      if (submission.refundAttemptId !== attempt.id) {
        throw new Error('Submission does not belong to refund attempt');
      }
      return {
        attempt: asAttempt(attempt),
        submission: asSubmission(submission),
        fingerprint: fingerprintOf(attempt),
      };
    });

    const listed = await this.stripe.listRefundsForPaymentIntent(
      prepared.attempt.stripePaymentIntentId,
    );

    if (!listed.ok || !listed.exhausted) {
      const detail = sanitizeRefundErrorDetail({
        message: listed.message,
        code: 'list_incomplete',
      });
      const persisted = await this.persistReconcileIncomplete({
        attemptId: prepared.attempt.id,
        submissionId: prepared.submission.id,
        detail,
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        classification: 'INCOMPLETE',
      };
    }

    // Prefer known id when present.
    if (prepared.submission.stripeRefundId) {
      const known = listed.refunds.find(
        (r) => r.id === prepared.submission.stripeRefundId,
      );
      if (known) {
        const persisted = await this.persistKnownRefundStatus({
          attemptId: prepared.attempt.id,
          submissionId: prepared.submission.id,
          refund: known,
          reconciliationResult: RefundReconciliationResult.MATCHED,
        });
        return {
          attempt: persisted.attempt,
          submission: persisted.submission,
          classification: isFailedRefundStatus(known.status)
            ? 'MATCHED_FAILED'
            : 'MATCHED_LIVE',
        };
      }
      // Known id missing from exhausted list — ambiguous, do not NO_MATCH.
      const persisted = await this.persistAmbiguous({
        attemptId: prepared.attempt.id,
        submissionId: prepared.submission.id,
        reason: 'known_refund_id_missing_from_list',
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        classification: 'AMBIGUOUS',
      };
    }

    const classification = classifyRefundReconciliation(
      listed.refunds,
      prepared.fingerprint,
    );

    if (classification.kind === 'AMBIGUOUS') {
      const persisted = await this.persistAmbiguous({
        attemptId: prepared.attempt.id,
        submissionId: prepared.submission.id,
        reason: classification.reason,
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        classification: 'AMBIGUOUS',
      };
    }

    if (classification.kind === 'MATCHED_LIVE') {
      const persisted = await this.persistKnownRefundStatus({
        attemptId: prepared.attempt.id,
        submissionId: prepared.submission.id,
        refund: classification.refund,
        reconciliationResult: RefundReconciliationResult.MATCHED,
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        classification: 'MATCHED_LIVE',
      };
    }

    if (classification.kind === 'MATCHED_FAILED') {
      const persisted = await this.persistKnownRefundStatus({
        attemptId: prepared.attempt.id,
        submissionId: prepared.submission.id,
        refund: classification.refund,
        reconciliationResult: RefundReconciliationResult.MATCHED,
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        classification: 'MATCHED_FAILED',
      };
    }

    // NO_MATCH — only open next version when safe (never for in-flight crash window).
    return this.persistNoMatchOrOpenNext({
      attemptId: prepared.attempt.id,
      submissionId: prepared.submission.id,
      operationKey: prepared.attempt.operationKey,
    });
  }

  /**
   * Submit (or refuse) Stripe create for the current open submission.
   * Claim txn → Stripe create outside → persist txn.
   */
  async submitCurrentSubmission(params: {
    refundAttemptId: string;
  }): Promise<SubmitCurrentSubmissionResult> {
    const claim = await this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.refundAttemptId);
      const attempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: params.refundAttemptId },
      });
      const submission = await tx.refundAttemptSubmission.findFirst({
        where: { refundAttemptId: attempt.id },
        orderBy: { version: 'desc' },
      });
      if (!submission) {
        throw new Error('RefundAttempt has no submission');
      }

      const view = toLatestView(submission);
      if (
        attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
        attempt.status === RefundAttemptStatus.APPLIED ||
        attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
        attempt.status === RefundAttemptStatus.PERMANENTLY_FAILED
      ) {
        return {
          blocked: true as const,
          reason: `attempt_status_${attempt.status}`,
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
        };
      }

      if (submission.reconciliationResult === RefundReconciliationResult.AMBIGUOUS) {
        return {
          blocked: true as const,
          reason: 'ambiguous_requires_admin',
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
        };
      }

      if (requiresReconcileBeforeStripeCreate(view)) {
        return {
          blocked: true as const,
          reason: 'must_reconcile_before_create',
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
        };
      }

      const retry = canRetryStripeCreateSameVersion(view);
      if (!retry.allowed) {
        // Maybe open next version if failed-object gate already satisfied.
        const nextGate = canInsertNextSubmissionVersion(view);
        if (nextGate.allowed) {
          return {
            blocked: true as const,
            reason: `open_next_version_first:${nextGate.reason}`,
            attempt: asAttempt(attempt),
            submission: asSubmission(submission),
          };
        }
        return {
          blocked: true as const,
          reason: retry.reason,
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
        };
      }

      const touched = await tx.refundAttemptSubmission.update({
        where: { id: submission.id },
        data: {
          submittedAt: submission.submittedAt ?? new Date(),
        },
      });

      return {
        blocked: false as const,
        attempt: asAttempt(attempt),
        submission: asSubmission(touched),
        fingerprint: fingerprintOf(attempt),
      };
    });

    if (claim.blocked) {
      return {
        attempt: claim.attempt,
        submission: claim.submission,
        created: false,
        blockedReason: claim.reason,
      };
    }

    const stripeResult = await this.stripe.createRefundForAttempt({
      paymentIntentId: claim.attempt.stripePaymentIntentId,
      amountCents: claim.attempt.amountCents,
      currency: claim.attempt.currency,
      orderId: claim.attempt.orderId,
      operationKey: claim.attempt.operationKey,
      idempotencyKey: claim.submission.stripeIdempotencyKey,
      returnRequestId: claim.attempt.returnRequestId,
    });

    if (!stripeResult.ok) {
      const detail = sanitizeRefundErrorDetail({
        message: stripeResult.message,
        code: stripeResult.uncertain ? 'uncertain_create' : 'create_rejected',
      });
      const persisted = await this.prisma.$transaction(async (tx) => {
        await this.lockAttempt(tx, claim.attempt.id);
        const submission = await tx.refundAttemptSubmission.findUniqueOrThrow({
          where: { id: claim.submission.id },
        });
        if (submission.stripeRefundId || submission.outcome === 'SUCCEEDED') {
          const attempt = await tx.refundAttempt.findUniqueOrThrow({
            where: { id: claim.attempt.id },
          });
          return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
        }
        const updatedSub = await tx.refundAttemptSubmission.update({
          where: { id: submission.id },
          data: {
            outcome: stripeResult.uncertain
              ? RefundSubmissionOutcome.SUBMISSION_UNKNOWN
              : RefundSubmissionOutcome.FAILED,
          },
        });
        const updatedAttempt = await tx.refundAttempt.update({
          where: { id: claim.attempt.id },
          data: {
            status: stripeResult.uncertain
              ? RefundAttemptStatus.SUBMISSION_UNKNOWN
              : RefundAttemptStatus.STRIPE_FAILED,
            lastError: detail,
          },
        });
        return {
          attempt: asAttempt(updatedAttempt),
          submission: asSubmission(updatedSub),
        };
      });
      return {
        attempt: persisted.attempt,
        submission: persisted.submission,
        created: false,
        blockedReason: stripeResult.uncertain
          ? 'stripe_create_uncertain'
          : 'stripe_create_failed',
      };
    }

    // Create response uniquely identifies the Stripe object for this version.
    const persisted = await this.persistKnownRefundStatus({
      attemptId: claim.attempt.id,
      submissionId: claim.submission.id,
      refund: {
        id: stripeResult.refund.id,
        amount: claim.attempt.amountCents,
        currency: claim.attempt.currency,
        status: stripeResult.refund.status,
        failureReason: stripeResult.refund.failureReason,
        metadata: {},
      },
      reconciliationResult: RefundReconciliationResult.MATCHED,
    });

    return {
      attempt: persisted.attempt,
      submission: persisted.submission,
      created: true,
    };
  }

  /**
   * Thin orchestrator: reconcile when required, then submit if allowed.
   * Never holds a DB transaction across Stripe calls.
   */
  async runStripePhase(params: {
    refundAttemptId: string;
  }): Promise<{
    reconcile?: ReconcileSubmissionResult;
    submit: SubmitCurrentSubmissionResult;
  }> {
    const latest = await this.prisma.refundAttemptSubmission.findFirst({
      where: { refundAttemptId: params.refundAttemptId },
      orderBy: { version: 'desc' },
    });
    if (!latest) {
      throw new Error('RefundAttempt has no submission');
    }

    let reconcile: ReconcileSubmissionResult | undefined;
    const view = toLatestView(latest);
    const needsReconcile =
      requiresReconcileBeforeStripeCreate(view) ||
      !!latest.stripeRefundId ||
      latest.reconciliationResult === RefundReconciliationResult.AMBIGUOUS;

    if (needsReconcile && latest.outcome !== RefundSubmissionOutcome.SUCCEEDED) {
      reconcile = await this.reconcileSubmission({
        refundAttemptId: params.refundAttemptId,
        submissionId: latest.id,
      });
    }

    // If NO_MATCH opened a next version, submit that; if failed gate allows next, open then submit.
    if (reconcile?.openedSubmission) {
      const submit = await this.submitCurrentSubmission({
        refundAttemptId: params.refundAttemptId,
      });
      return { reconcile, submit };
    }

    if (
      reconcile?.classification === 'MATCHED_FAILED' ||
      (latest.outcome === 'FAILED' &&
        latest.reconciliationResult === 'MATCHED')
    ) {
      const after = await this.ensureNextVersionIfAllowed(params.refundAttemptId);
      if (after) {
        const submit = await this.submitCurrentSubmission({
          refundAttemptId: params.refundAttemptId,
        });
        return { reconcile, submit };
      }
    }

    const submit = await this.submitCurrentSubmission({
      refundAttemptId: params.refundAttemptId,
    });
    return { reconcile, submit };
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

  /** Exposed for tests — S2.2 eligibility helper. */
  isReadyForApply(input: {
    attemptStatus: string;
    submissionOutcome: LatestSubmissionView['outcome'];
    submissionStripeRefundId: string | null | undefined;
    succeededSubmissionCount?: number;
  }): boolean {
    return isApplyEligibleStripeSuccess(input);
  }

  private async ensureNextVersionIfAllowed(
    refundAttemptId: string,
  ): Promise<SubmissionRow | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, refundAttemptId);
      const attempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: refundAttemptId },
      });
      if (
        attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
        attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
        attempt.status === RefundAttemptStatus.APPLIED ||
        attempt.investigationReason === INFLIGHT_UNRESOLVED_REASON
      ) {
        return null;
      }
      const latest = await tx.refundAttemptSubmission.findFirst({
        where: { refundAttemptId },
        orderBy: { version: 'desc' },
      });
      if (!latest) return null;
      if (isUnresolvedClaimedStripeCreate(toLatestView(latest))) {
        return null;
      }
      const gate = canInsertNextSubmissionVersion(toLatestView(latest));
      if (!gate.allowed) return null;
      if (latest.outcome === RefundSubmissionOutcome.PENDING) {
        return asSubmission(latest);
      }
      return this.openNextSubmissionVersionTx(tx, attempt);
    });
  }

  private async openNextSubmissionVersion(
    attemptId: string,
    _priorHint: { id: string; version: number; outcome: RefundSubmissionOutcome },
  ): Promise<SubmissionRow> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, attemptId);
      const attempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      return this.openNextSubmissionVersionTx(tx, attempt);
    });
  }

  /**
   * Opens version+1 under lock after re-reading the latest submission.
   * Unique conflicts re-read the existing next version instead of leaving inconsistency.
   */
  private async openNextSubmissionVersionTx(
    tx: Prisma.TransactionClient,
    attempt: {
      id: string;
      operationKey: string;
      status: RefundAttemptStatus;
      investigationReason?: string | null;
    },
  ): Promise<SubmissionRow> {
    if (
      attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
      attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
      attempt.status === RefundAttemptStatus.APPLIED ||
      attempt.investigationReason === INFLIGHT_UNRESOLVED_REASON
    ) {
      const latest = await tx.refundAttemptSubmission.findFirstOrThrow({
        where: { refundAttemptId: attempt.id },
        orderBy: { version: 'desc' },
      });
      return asSubmission(latest);
    }

    const prior = await tx.refundAttemptSubmission.findFirstOrThrow({
      where: { refundAttemptId: attempt.id },
      orderBy: { version: 'desc' },
    });
    const gate = canInsertNextSubmissionVersion(toLatestView(prior));
    if (!gate.allowed) {
      return asSubmission(prior);
    }
    if (prior.outcome === RefundSubmissionOutcome.PENDING && !prior.stripeRefundId) {
      // Already have an open untouched or in-flight row — do not insert another.
      if (!isInFlightUncertainSubmission(toLatestView(prior))) {
        return asSubmission(prior);
      }
      // In-flight cannot open next via this path.
      return asSubmission(prior);
    }

    if (prior.outcome !== RefundSubmissionOutcome.SUPERSEDED_BY_NO_MATCH) {
      await tx.refundAttemptSubmission.update({
        where: { id: prior.id },
        data: {
          outcome: RefundSubmissionOutcome.SUPERSEDED_BY_NO_MATCH,
          reconciliationResult:
            prior.outcome === RefundSubmissionOutcome.FAILED &&
            prior.reconciliationResult === RefundReconciliationResult.MATCHED
              ? RefundReconciliationResult.MATCHED
              : prior.reconciliationResult === RefundReconciliationResult.NO_MATCH
                ? RefundReconciliationResult.NO_MATCH
                : prior.outcome === RefundSubmissionOutcome.FAILED
                  ? RefundReconciliationResult.MATCHED
                  : RefundReconciliationResult.NO_MATCH,
        },
      });
    }

    const nextVersion = prior.version + 1;
    try {
      const next = await tx.refundAttemptSubmission.create({
        data: {
          refundAttemptId: attempt.id,
          version: nextVersion,
          stripeIdempotencyKey: stripeIdempotencyKeyForSubmission(
            attempt.operationKey,
            nextVersion,
          ),
          outcome: RefundSubmissionOutcome.PENDING,
          reconciliationResult: RefundReconciliationResult.NONE,
        },
      });
      await tx.refundAttempt.update({
        where: { id: attempt.id },
        data: {
          status: RefundAttemptStatus.PENDING,
          lastError: null,
          investigationReason: null,
        },
      });
      return asSubmission(next);
    } catch (error) {
      if (isUniqueConflict(error)) {
        const existing = await tx.refundAttemptSubmission.findFirstOrThrow({
          where: { refundAttemptId: attempt.id },
          orderBy: { version: 'desc' },
        });
        return asSubmission(existing);
      }
      throw error;
    }
  }

  private async insertSubmissionVersion(
    attemptId: string,
    operationKey: string,
    version: number,
  ): Promise<SubmissionRow> {
    const row = await this.prisma.refundAttemptSubmission.create({
      data: {
        refundAttemptId: attemptId,
        version,
        stripeIdempotencyKey: stripeIdempotencyKeyForSubmission(
          operationKey,
          version,
        ),
        outcome: RefundSubmissionOutcome.PENDING,
        reconciliationResult: RefundReconciliationResult.NONE,
      },
    });
    return asSubmission(row);
  }

  private async lockAttempt(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "RefundAttempt" WHERE id = ${attemptId} FOR UPDATE
    `;
  }

  private async persistNoMatchOrOpenNext(params: {
    attemptId: string;
    submissionId: string;
    operationKey: string;
  }): Promise<ReconcileSubmissionResult> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.attemptId);
      const attempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: params.attemptId },
      });
      const submission = await tx.refundAttemptSubmission.findUniqueOrThrow({
        where: { id: params.submissionId },
      });
      const latest = await tx.refundAttemptSubmission.findFirstOrThrow({
        where: { refundAttemptId: params.attemptId },
        orderBy: { version: 'desc' },
      });

      // Never open versions from a stale submission while a newer one exists.
      if (submission.id !== latest.id) {
        return {
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
          classification: 'STALE_SUBMISSION_IGNORED' as const,
        };
      }

      if (
        attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
        attempt.status === RefundAttemptStatus.APPLIED ||
        attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION
      ) {
        return {
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
          classification: 'STALE_SUBMISSION_IGNORED' as const,
        };
      }

      if (
        submission.outcome === RefundSubmissionOutcome.SUCCEEDED ||
        submission.reconciliationResult === RefundReconciliationResult.AMBIGUOUS
      ) {
        return {
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
          classification: 'NO_MATCH' as const,
        };
      }

      // Claimed create with no refund id (PENDING in-flight or retained UNKNOWN):
      // an empty exhausted list is not proof the Stripe create never happened.
      // Never auto NO_MATCH / open v2 — including on repeated reconciliations.
      const view = toLatestView(submission);
      if (
        isUnresolvedClaimedStripeCreate(view) ||
        attempt.investigationReason === INFLIGHT_UNRESOLVED_REASON
      ) {
        const updatedSub = await tx.refundAttemptSubmission.update({
          where: { id: submission.id },
          data: {
            outcome: RefundSubmissionOutcome.SUBMISSION_UNKNOWN,
            // Do not write NO_MATCH — empty list leaves create uncertainty intact.
          },
        });
        const updatedAttempt = await tx.refundAttempt.update({
          where: { id: attempt.id },
          data: {
            status: RefundAttemptStatus.SUBMISSION_UNKNOWN,
            lastError: sanitizeRefundErrorDetail({
              code: 'inflight_no_match_unresolved',
              message:
                'claimed create unresolved; empty list is not confirmed NO_MATCH',
            }),
            investigationReason: INFLIGHT_UNRESOLVED_REASON,
          },
        });
        return {
          attempt: asAttempt(updatedAttempt),
          submission: asSubmission(updatedSub),
          classification: 'UNRESOLVED_INFLIGHT' as const,
        };
      }

      const updatedPrior = await tx.refundAttemptSubmission.update({
        where: { id: submission.id },
        data: {
          reconciliationResult: RefundReconciliationResult.NO_MATCH,
          outcome:
            submission.outcome === RefundSubmissionOutcome.PENDING ||
            submission.outcome === RefundSubmissionOutcome.SUBMISSION_UNKNOWN ||
            submission.outcome === RefundSubmissionOutcome.FAILED
              ? RefundSubmissionOutcome.SUPERSEDED_BY_NO_MATCH
              : submission.outcome,
        },
      });

      const opened = await this.openNextSubmissionVersionTx(tx, attempt);
      const freshAttempt = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      return {
        attempt: asAttempt(freshAttempt),
        submission: asSubmission(updatedPrior),
        classification:
          opened.id !== updatedPrior.id
            ? ('OPENED_NEXT_VERSION' as const)
            : ('NO_MATCH' as const),
        openedSubmission:
          opened.id !== updatedPrior.id ? opened : undefined,
      };
    });
  }

  private async persistReconcileIncomplete(params: {
    attemptId: string;
    submissionId: string;
    detail: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.attemptId);
      const attemptBefore = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: params.attemptId },
      });
      const prior = await tx.refundAttemptSubmission.findUniqueOrThrow({
        where: { id: params.submissionId },
      });

      const submission = await tx.refundAttemptSubmission.update({
        where: { id: params.submissionId },
        data: {
          outcome:
            prior.outcome === RefundSubmissionOutcome.SUCCEEDED
              ? prior.outcome
              : RefundSubmissionOutcome.SUBMISSION_UNKNOWN,
        },
      });

      // Incomplete list must never downgrade a successful attempt.
      if (attemptHasProtectedSuccess(attemptBefore)) {
        return {
          attempt: asAttempt(attemptBefore),
          submission: asSubmission(submission),
        };
      }

      const attempt = await tx.refundAttempt.update({
        where: { id: params.attemptId },
        data: {
          status: RefundAttemptStatus.SUBMISSION_UNKNOWN,
          lastError: params.detail,
          investigationReason: 'list_incomplete',
        },
      });
      return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
    });
  }

  private async persistAmbiguous(params: {
    attemptId: string;
    submissionId: string;
    reason: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.attemptId);

      const submission = await tx.refundAttemptSubmission.update({
        where: { id: params.submissionId },
        data: {
          reconciliationResult: RefundReconciliationResult.AMBIGUOUS,
        },
      });

      // Flag investigation; do not touch stripeRefundId (preserves successful id).
      const attempt = await tx.refundAttempt.update({
        where: { id: params.attemptId },
        data: {
          status: RefundAttemptStatus.NEEDS_INVESTIGATION,
          investigationReason: truncateReason(params.reason),
          lastError: sanitizeRefundErrorDetail({
            code: 'ambiguous',
            message: params.reason,
          }),
        },
      });
      return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
    });
  }

  private async persistKnownRefundStatus(params: {
    attemptId: string;
    submissionId: string;
    refund: {
      id: string;
      status: string | null;
      failureReason?: string | null;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
    };
    reconciliationResult: RefundReconciliationResult;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAttempt(tx, params.attemptId);
      const attemptBefore = await tx.refundAttempt.findUniqueOrThrow({
        where: { id: params.attemptId },
      });
      const prior = await tx.refundAttemptSubmission.findUniqueOrThrow({
        where: { id: params.submissionId },
      });
      const latest = await tx.refundAttemptSubmission.findFirstOrThrow({
        where: { refundAttemptId: params.attemptId },
        orderBy: { version: 'desc' },
      });
      const isLatest = prior.id === latest.id;

      // Never erase a different historical refund id on this version.
      if (prior.stripeRefundId && prior.stripeRefundId !== params.refund.id) {
        const submission = await tx.refundAttemptSubmission.update({
          where: { id: params.submissionId },
          data: {
            reconciliationResult: RefundReconciliationResult.AMBIGUOUS,
          },
        });
        const attempt = await tx.refundAttempt.update({
          where: { id: params.attemptId },
          data: {
            status: RefundAttemptStatus.NEEDS_INVESTIGATION,
            investigationReason: 'conflicting_stripe_refund_id',
            lastError: sanitizeRefundErrorDetail({
              code: 'id_conflict',
              message: `${prior.stripeRefundId} vs ${params.refund.id}`,
            }),
            // Preserve existing successful attempt id.
          },
        });
        return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
      }

      const status = params.refund.status;
      let outcome: RefundSubmissionOutcome = prior.outcome;
      let lastError: string | null = prior.outcome === RefundSubmissionOutcome.SUCCEEDED
        ? null
        : null;
      let submissionInvestigation: string | null = null;

      if (isSucceededRefundStatus(status)) {
        outcome = RefundSubmissionOutcome.SUCCEEDED;
        lastError = null;
      } else if (isLiveRefundStatus(status)) {
        outcome = RefundSubmissionOutcome.PENDING;
        if (status === 'requires_action') {
          submissionInvestigation = 'stripe_status=requires_action';
          lastError = sanitizeRefundErrorDetail({
            stripeStatus: status,
            failureReason: params.refund.failureReason,
          });
        } else {
          lastError = sanitizeRefundErrorDetail({
            stripeStatus: status ?? 'pending',
          });
        }
      } else if (isFailedRefundStatus(status)) {
        outcome = RefundSubmissionOutcome.FAILED;
        lastError = sanitizeRefundErrorDetail({
          stripeStatus: status,
          failureReason: params.refund.failureReason,
        });
      } else {
        outcome = RefundSubmissionOutcome.SUBMISSION_UNKNOWN;
        lastError = sanitizeRefundErrorDetail({
          stripeStatus: status,
          code: 'unknown_refund_status',
        });
        submissionInvestigation = 'unknown_refund_status';
      }

      // Always preserve this version's Stripe id and outcome history.
      const submission = await tx.refundAttemptSubmission.update({
        where: { id: params.submissionId },
        data: {
          stripeRefundId: params.refund.id,
          outcome,
          reconciliationResult: params.reconciliationResult,
          submittedAt: prior.submittedAt ?? new Date(),
        },
      });

      const succeeded = await tx.refundAttemptSubmission.findMany({
        where: {
          refundAttemptId: params.attemptId,
          outcome: RefundSubmissionOutcome.SUCCEEDED,
          stripeRefundId: { not: null },
        },
        orderBy: { version: 'asc' },
      });

      // Multiple successful Stripe refunds across versions → investigation; block ordinary apply.
      if (succeeded.length > 1) {
        const attempt = await tx.refundAttempt.update({
          where: { id: params.attemptId },
          data: {
            status: RefundAttemptStatus.NEEDS_INVESTIGATION,
            investigationReason: 'multiple_successful_stripe_refunds',
            lastError: sanitizeRefundErrorDetail({
              code: 'multiple_success',
              message: succeeded.map((s) => s.stripeRefundId).join(','),
            }),
            // Do not pick a single attempt-level id when multiple succeeded.
            stripeRefundId: null,
          },
        });
        return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
      }

      if (isSucceededRefundStatus(status)) {
        const attempt = await tx.refundAttempt.update({
          where: { id: params.attemptId },
          data: {
            status: RefundAttemptStatus.STRIPE_SUCCEEDED,
            stripeRefundId: params.refund.id,
            lastError: null,
            investigationReason: null,
          },
        });
        return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
      }

      // Non-success on a stale (non-latest) submission: never downgrade a protected attempt.
      if (!isLatest && attemptHasProtectedSuccess(attemptBefore)) {
        return {
          attempt: asAttempt(attemptBefore),
          submission: asSubmission(submission),
        };
      }

      // Non-success on latest (or unprotected attempt): update attempt from this result.
      let attemptStatus: RefundAttemptStatus = RefundAttemptStatus.PENDING;
      let attemptStripeRefundId: string | null = attemptBefore.stripeRefundId;
      let investigationReason: string | null = submissionInvestigation;

      if (isLiveRefundStatus(status)) {
        attemptStatus = RefundAttemptStatus.PENDING;
        // Attempt-level id only for succeeded.
        if (!attemptHasProtectedSuccess(attemptBefore)) {
          attemptStripeRefundId = null;
        }
      } else if (isFailedRefundStatus(status)) {
        attemptStatus = RefundAttemptStatus.STRIPE_FAILED;
        if (!attemptHasProtectedSuccess(attemptBefore)) {
          attemptStripeRefundId = null;
        }
      } else {
        attemptStatus = RefundAttemptStatus.SUBMISSION_UNKNOWN;
        investigationReason = investigationReason ?? 'unknown_refund_status';
      }

      if (attemptHasProtectedSuccess(attemptBefore) && !isLatest) {
        return {
          attempt: asAttempt(attemptBefore),
          submission: asSubmission(submission),
        };
      }

      const attempt = await tx.refundAttempt.update({
        where: { id: params.attemptId },
        data: {
          status: attemptStatus,
          stripeRefundId: attemptStripeRefundId,
          lastError,
          investigationReason,
        },
      });

      return { attempt: asAttempt(attempt), submission: asSubmission(submission) };
    });
  }
}

function fingerprintOf(attempt: {
  orderId: string;
  operationKey: string;
  amountCents: number;
  currency: string;
  returnRequestId: string | null;
}): RefundFingerprint {
  return {
    orderId: attempt.orderId,
    operationKey: attempt.operationKey,
    amountCents: attempt.amountCents,
    currency: attempt.currency,
    returnRequestId: attempt.returnRequestId,
  };
}

function toLatestView(submission: {
  version: number;
  outcome: RefundSubmissionOutcome;
  reconciliationResult: RefundReconciliationResult;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
  stripeRefundId?: string | null;
}): LatestSubmissionView {
  return {
    version: submission.version,
    outcome: submission.outcome,
    reconciliationResult: submission.reconciliationResult,
    stripeIdempotencyKey: submission.stripeIdempotencyKey,
    submittedAt: submission.submittedAt,
    stripeRefundId: submission.stripeRefundId,
  };
}

function asAttempt(row: {
  id: string;
  operationKey: string;
  kind: RefundAttemptKind;
  status: RefundAttemptStatus;
  orderId: string;
  returnRequestId: string | null;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amountCents: number;
  currency: string;
  lastError: string | null;
  investigationReason: string | null;
}): AttemptRow {
  return {
    id: row.id,
    operationKey: row.operationKey,
    kind: row.kind,
    status: row.status,
    orderId: row.orderId,
    returnRequestId: row.returnRequestId,
    stripePaymentIntentId: row.stripePaymentIntentId,
    stripeRefundId: row.stripeRefundId,
    amountCents: row.amountCents,
    currency: row.currency,
    lastError: row.lastError,
    investigationReason: row.investigationReason,
  };
}

function asSubmission(row: {
  id: string;
  refundAttemptId: string;
  version: number;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
  reconciliationResult: RefundReconciliationResult;
  stripeRefundId: string | null;
  outcome: RefundSubmissionOutcome;
}): SubmissionRow {
  return {
    id: row.id,
    refundAttemptId: row.refundAttemptId,
    version: row.version,
    stripeIdempotencyKey: row.stripeIdempotencyKey,
    submittedAt: row.submittedAt,
    reconciliationResult: row.reconciliationResult,
    stripeRefundId: row.stripeRefundId,
    outcome: row.outcome,
  };
}

function truncateReason(reason: string): string {
  return reason.length <= 200 ? reason : `${reason.slice(0, 197)}...`;
}

function attemptHasProtectedSuccess(attempt: {
  status: RefundAttemptStatus;
  stripeRefundId: string | null;
}): boolean {
  return (
    attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
    attempt.status === RefundAttemptStatus.APPLIED ||
    (attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION &&
      !!attempt.stripeRefundId)
  );
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    (error as { code: string }).code === 'P2002'
  );
}
