import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  Prisma,
  RefundAttemptKind,
  RefundAttemptStatus,
  RefundReconciliationResult,
  RefundSubmissionOutcome,
  ReturnRefundStatus,
  ShipmentRefundHoldStatus,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { CommissionLedgerService } from '../commissions/commission-ledger.service';
import { roundMoney, shipmentPaymentTotal } from './settlement-allocation';
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
  canStartApplyFromStatus,
  hasInconsistentApplyMarkers,
  INFLIGHT_UNRESOLVED_REASON,
  isApplyActorAllowed,
  isApplyEligibleStripeSuccess,
  isConsistentlyApplied,
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
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';
import { ShipmentRefundHoldError } from './shipment-refund-hold.types';

type AttemptRow = {
  id: string;
  operationKey: string;
  kind: RefundAttemptKind;
  status: RefundAttemptStatus;
  orderId: string;
  returnRequestId: string | null;
  orderItemId: string | null;
  orderShipmentId: string | null;
  supplierId: string | null;
  actorUserId: string;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amountCents: number;
  currency: string;
  shipmentRefundApplied: boolean;
  clawbackAppliedAt: Date | null;
  appliedAt: Date | null;
  applyError: string | null;
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

export type ApplySuccessfulRefundResult = {
  attempt: AttemptRow;
  idempotent: boolean;
  /** Set when RETURN apply also finalised ReturnRequest to ISSUED. */
  returnIssued?: boolean;
};

type SubmissionRowLike = {
  id: string;
  refundAttemptId: string;
  version: number;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
  reconciliationResult: RefundReconciliationResult;
  stripeRefundId: string | null;
  outcome: RefundSubmissionOutcome;
};

/** Validation / invariant failures that must not leave money half-applied. */
class ApplyInvariantError extends Error {
  readonly code: string;
  readonly needsInvestigation: boolean;

  constructor(
    code: string,
    message: string,
    opts?: { needsInvestigation?: boolean },
  ) {
    super(message);
    this.name = 'ApplyInvariantError';
    this.code = code;
    this.needsInvestigation = opts?.needsInvestigation === true;
  }
}

/**
 * Phase 3 RefundAttempt orchestration (S2.1 + S2.2 apply + S2.3 hold/abandon).
 */
@Injectable()
export class RefundAttemptService {
  private readonly logger = new Logger(RefundAttemptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly ledger: CommissionLedgerService,
    private readonly holds: ShipmentRefundHoldService,
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
   * Pass `tx` to join an outer transaction (no nested $transaction).
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
    /** When set, use this client and do not open a nested transaction. */
    tx?: Prisma.TransactionClient;
  }): Promise<EnsureAttemptResult> {
    if (params.tx) {
      return this.ensureAttemptForOperationTx(params.tx, params);
    }
    const existing = await this.prisma.refundAttempt.findUnique({
      where: { operationKey: params.operationKey },
      include: {
        submissions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (existing) {
      return this.ensureExistingAttempt(existing, params);
    }
    const created = await this.prisma.$transaction(async (tx) =>
      this.createAttemptWithSubmissionTx(tx, params),
    );
    return {
      attempt: asAttempt(created.attempt),
      submission: asSubmission(created.submission),
    };
  }

  /** Transaction-client helper — never opens a nested transaction. */
  async ensureAttemptForOperationTx(
    tx: Prisma.TransactionClient,
    params: {
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
    },
  ): Promise<EnsureAttemptResult> {
    const existing = await tx.refundAttempt.findUnique({
      where: { operationKey: params.operationKey },
      include: {
        submissions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });
    if (existing) {
      return this.ensureExistingAttemptTx(tx, existing, params);
    }
    const created = await this.createAttemptWithSubmissionTx(tx, params);
    return {
      attempt: asAttempt(created.attempt),
      submission: asSubmission(created.submission),
    };
  }

  private assertFrozenAttemptMatches(
    existing: {
      operationKey: string;
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
    },
    params: {
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
    },
  ): string {
    const currency = params.currency.toLowerCase();
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
    return currency;
  }

  private async ensureExistingAttempt(
    existing: {
      id: string;
      operationKey: string;
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
      submissions: SubmissionRowLike[];
    } & Record<string, unknown>,
    params: {
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
      operationKey: string;
    },
  ): Promise<EnsureAttemptResult> {
    this.assertFrozenAttemptMatches(existing, params);
    const latest = existing.submissions[0] ?? null;
    if (!latest) {
      const createdSub = await this.insertSubmissionVersion(
        existing.id,
        params.operationKey,
        1,
      );
      return { attempt: asAttempt(existing as never), submission: createdSub };
    }
    const gate = canInsertNextSubmissionVersion(toLatestView(latest));
    if (gate.allowed && latest.outcome !== RefundSubmissionOutcome.PENDING) {
      const opened = await this.openNextSubmissionVersion(existing.id, latest);
      const attempt = await this.prisma.refundAttempt.findUniqueOrThrow({
        where: { id: existing.id },
      });
      return { attempt: asAttempt(attempt), submission: opened };
    }
    return {
      attempt: asAttempt(existing as never),
      submission: asSubmission(latest),
    };
  }

  private async ensureExistingAttemptTx(
    tx: Prisma.TransactionClient,
    existing: {
      id: string;
      operationKey: string;
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
      status: RefundAttemptStatus;
      submissions: SubmissionRowLike[];
    } & Record<string, unknown>,
    params: {
      amountCents: number;
      currency: string;
      stripePaymentIntentId: string;
      operationKey: string;
    },
  ): Promise<EnsureAttemptResult> {
    this.assertFrozenAttemptMatches(existing, params);
    if (existing.status === RefundAttemptStatus.PERMANENTLY_FAILED) {
      const latest = existing.submissions[0];
      if (!latest) {
        throw new BadRequestException(
          'RefundAttempt is PERMANENTLY_FAILED; new submission versions blocked',
        );
      }
      return {
        attempt: asAttempt(existing as never),
        submission: asSubmission(latest),
      };
    }
    const latest = existing.submissions[0] ?? null;
    if (!latest) {
      const createdSub = await this.insertSubmissionVersionTx(
        tx,
        existing.id,
        params.operationKey,
        1,
      );
      return { attempt: asAttempt(existing as never), submission: createdSub };
    }
    // Inside an outer claim txn we never open next versions — reuse frozen hold/attempt.
    return {
      attempt: asAttempt(existing as never),
      submission: asSubmission(latest),
    };
  }

  private async createAttemptWithSubmissionTx(
    tx: Prisma.TransactionClient,
    params: {
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
    },
  ): Promise<{
    attempt: Parameters<typeof asAttempt>[0];
    submission: Parameters<typeof asSubmission>[0];
  }> {
    const currency = params.currency.toLowerCase();
    const kind = params.kind as RefundAttemptKind;
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

      const abandonGate = await this.abandonBlocksNewStripeCreateTx(tx, attempt);
      if (abandonGate.blocked) {
        return {
          blocked: true as const,
          reason: abandonGate.reason,
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
        };
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
   * S2.2: atomically apply shipment.refundedAmount + RETURN clawback after Stripe success.
   * Lock order: RefundAttempt → OrderShipment → ledger supplier credits (inside applyReturnClawback).
   * Never calls Stripe. Never uses clawbackForOrderItem.
   */
  async applySuccessfulRefund(params: {
    refundAttemptId: string;
    actor: AuthUser;
  }): Promise<ApplySuccessfulRefundResult> {
    if (!params.actor?.sub || !params.actor.role) {
      throw new ForbiddenException('apply_requires_auth_user');
    }

    type TxOutcome =
      | { kind: 'ok'; result: ApplySuccessfulRefundResult }
      | { kind: 'investigation'; attempt: AttemptRow };

    let outcome: TxOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // 1) RefundAttempt FOR UPDATE
        await this.lockAttempt(tx, params.refundAttemptId);
        const attempt = await tx.refundAttempt.findUniqueOrThrow({
          where: { id: params.refundAttemptId },
        });

        if (
          !isApplyActorAllowed(
            { sub: params.actor.sub, role: params.actor.role },
            attempt.actorUserId,
          )
        ) {
          throw new ForbiddenException('apply_actor_not_allowed');
        }

        const markers = {
          status: attempt.status,
          appliedAt: attempt.appliedAt,
          shipmentRefundApplied: attempt.shipmentRefundApplied,
          clawbackAppliedAt: attempt.clawbackAppliedAt,
        };

        // 2) Fully consistent APPLIED → idempotent success
        if (isConsistentlyApplied(markers)) {
          return {
            kind: 'ok' as const,
            result: { attempt: asAttempt(attempt), idempotent: true },
          };
        }

        // 3) Partial / inconsistent markers → investigate, no money movement.
        // Return (do not throw) so NEEDS_INVESTIGATION commits with the txn.
        if (hasInconsistentApplyMarkers(markers)) {
          const updated = await tx.refundAttempt.update({
            where: { id: attempt.id },
            data: {
              status: RefundAttemptStatus.NEEDS_INVESTIGATION,
              investigationReason: 'apply_flags_inconsistent',
              applyError: sanitizeRefundErrorDetail({
                code: 'apply_flags_inconsistent',
                message: 'partial or inconsistent apply markers',
              }),
              lastError: sanitizeRefundErrorDetail({
                code: 'apply_flags_inconsistent',
                message: 'partial or inconsistent apply markers',
              }),
            },
          });
          return {
            kind: 'investigation' as const,
            attempt: asAttempt(updated),
          };
        }

        if (!canStartApplyFromStatus(attempt.status)) {
          throw new ApplyInvariantError(
            'apply_status_not_eligible',
            `RefundAttempt status ${attempt.status} cannot start apply`,
          );
        }

        if (attempt.kind !== RefundAttemptKind.RETURN) {
          throw new ApplyInvariantError(
            'apply_kind_not_supported',
            `RefundAttempt kind ${attempt.kind} is not supported by S2.2 apply`,
          );
        }

        if (
          !attempt.returnRequestId ||
          !attempt.orderShipmentId ||
          !attempt.orderItemId
        ) {
          throw new ApplyInvariantError(
            'apply_links_incomplete',
            'RETURN apply requires returnRequestId, orderShipmentId, and orderItemId',
          );
        }

        const succeededSubs = await tx.refundAttemptSubmission.findMany({
          where: {
            refundAttemptId: attempt.id,
            outcome: RefundSubmissionOutcome.SUCCEEDED,
            stripeRefundId: { not: null },
          },
          orderBy: { version: 'asc' },
        });
        if (succeededSubs.length !== 1) {
          throw new ApplyInvariantError(
            succeededSubs.length === 0
              ? 'apply_no_succeeded_submission'
              : 'apply_multiple_succeeded_submissions',
            `Expected exactly one SUCCEEDED submission with refund id, found ${succeededSubs.length}`,
            { needsInvestigation: succeededSubs.length > 1 },
          );
        }
        const successSub = succeededSubs[0]!;
        if (
          !attempt.stripeRefundId ||
          successSub.stripeRefundId !== attempt.stripeRefundId
        ) {
          throw new ApplyInvariantError(
            'apply_stripe_refund_id_mismatch',
            'Attempt stripeRefundId must match the sole SUCCEEDED submission',
            { needsInvestigation: true },
          );
        }
        if (
          !isApplyEligibleStripeSuccess({
            attemptStatus: attempt.status,
            submissionOutcome: successSub.outcome,
            submissionStripeRefundId: successSub.stripeRefundId,
            succeededSubmissionCount: 1,
          })
        ) {
          throw new ApplyInvariantError(
            'apply_stripe_not_eligible',
            'Stripe success eligibility check failed',
          );
        }

        // Validate frozen amount before locking shipment or any money writes.
        const frozenAmount = resolveFrozenRefundAmount(attempt);

        // 4) OrderShipment FOR UPDATE (after attempt; before hold + ledger)
        // Do not lock ReturnRequest here — preserve Attempt-first apply order.
        await this.lockShipment(tx, attempt.orderShipmentId);
        const shipment = await tx.orderShipment.findUniqueOrThrow({
          where: { id: attempt.orderShipmentId },
        });
        if (shipment.orderId !== attempt.orderId) {
          throw new ApplyInvariantError(
            'apply_shipment_order_mismatch',
            'OrderShipment.orderId does not match RefundAttempt.orderId',
            { needsInvestigation: true },
          );
        }
        if (
          attempt.supplierId != null &&
          shipment.supplierId !== attempt.supplierId
        ) {
          throw new ApplyInvariantError(
            'apply_shipment_supplier_mismatch',
            'OrderShipment.supplierId does not match RefundAttempt.supplierId',
            { needsInvestigation: true },
          );
        }

        const order = await tx.order.findUniqueOrThrow({
          where: { id: attempt.orderId },
          select: { currency: true },
        });
        if (
          order.currency.toLowerCase() !== attempt.currency.toLowerCase()
        ) {
          throw new ApplyInvariantError(
            'apply_currency_mismatch',
            'Frozen attempt currency does not match order payment currency',
          );
        }

        const paymentTotal = shipmentPaymentTotal({
          paymentMerchandise: Number(shipment.paymentMerchandise),
          paymentDelivery: Number(shipment.paymentDelivery),
          paymentTax: Number(shipment.paymentTax),
        });
        const alreadyRefunded = roundMoney(Number(shipment.refundedAmount));
        const nextRefunded = roundMoney(alreadyRefunded + frozenAmount);
        if (nextRefunded - paymentTotal > 0.001) {
          throw new ApplyInvariantError(
            'shipment_refund_capacity',
            'Frozen refund amount exceeds remaining shipment payment capacity',
          );
        }

        // 4b) Consume shared hold (S2.3) — Attempt → Shipment → Hold
        try {
          await this.holds.consumeHoldForApplyTx(tx, {
            returnRequestId: attempt.returnRequestId,
            refundAttemptId: attempt.id,
            expectedAmount: frozenAmount,
            expectedAmountCents: attempt.amountCents,
            expectedCurrency: attempt.currency,
            orderShipmentId: attempt.orderShipmentId,
          });
        } catch (holdError) {
          if (holdError instanceof ShipmentRefundHoldError) {
            throw new ApplyInvariantError(holdError.code, holdError.message, {
              needsInvestigation: holdError.code === 'hold_released',
            });
          }
          throw holdError;
        }

        const now = new Date();
        if (!attempt.shipmentRefundApplied) {
          await tx.orderShipment.update({
            where: { id: shipment.id },
            data: {
              refundedAmount: new Prisma.Decimal(nextRefunded.toFixed(2)),
            },
          });
        }

        // 5) Clawback: verified no-op OR applyReturnClawback (never clawbackForOrderItem)
        await this.applyReturnClawbackForAttempt(tx, {
          returnRequestId: attempt.returnRequestId,
          orderItemId: attempt.orderItemId,
          actor: params.actor,
        });

        const updated = await tx.refundAttempt.update({
          where: { id: attempt.id },
          data: {
            status: RefundAttemptStatus.APPLIED,
            shipmentRefundApplied: true,
            clawbackAppliedAt: now,
            appliedAt: now,
            applyError: null,
            lastError: null,
            investigationReason: null,
          },
        });

        return {
          kind: 'ok' as const,
          result: { attempt: asAttempt(updated), idempotent: false },
        };
      });
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Concurrent winner may have committed APPLIED after our txn rolled back.
      // Re-read before and after failure recording / transient exits.
      // Only the fully consistent APPLIED quadruple counts as success.
      const readIdempotentApplied =
        async (): Promise<ApplySuccessfulRefundResult | null> => {
          const fresh = await this.prisma.refundAttempt.findUnique({
            where: { id: params.refundAttemptId },
          });
          if (
            fresh &&
            isConsistentlyApplied({
              status: fresh.status,
              appliedAt: fresh.appliedAt,
              shipmentRefundApplied: fresh.shipmentRefundApplied,
              clawbackAppliedAt: fresh.clawbackAppliedAt,
            })
          ) {
            return { attempt: asAttempt(fresh), idempotent: true };
          }
          return null;
        };

      const early = await readIdempotentApplied();
      if (early) return early;

      if (isTransientDbError(error)) {
        const afterTransient = await readIdempotentApplied();
        if (afterTransient) return afterTransient;
        throw error;
      }

      try {
        await this.recordApplyFailure({
          refundAttemptId: params.refundAttemptId,
          error,
        });
      } catch (recordError) {
        const afterRecordError = await readIdempotentApplied();
        if (afterRecordError) return afterRecordError;
        const original =
          error instanceof Error ? error.message : String(error);
        const recording =
          recordError instanceof Error
            ? recordError.message
            : String(recordError);
        throw new Error(
          `applySuccessfulRefund failed: ${original}; also failed to record failure: ${recording}`,
        );
      }

      const afterFailureRecord = await readIdempotentApplied();
      if (afterFailureRecord) return afterFailureRecord;

      throw error;
    }

    if (outcome.kind === 'investigation') {
      throw new ApplyInvariantError(
        'apply_flags_inconsistent',
        'RefundAttempt apply markers are inconsistent',
        { needsInvestigation: true },
      );
    }

    // Finalise ReturnRequest ISSUED only after apply commits (S2.3).
    const returnIssued = await this.finalizeReturnIssuedAfterApply(
      outcome.result.attempt,
    );
    return { ...outcome.result, returnIssued };
  }

  /**
   * After APPLIED commits, set ReturnRequest ISSUED.
   * Separate short transaction — never inside the Attempt→Shipment apply lock set.
   */
  private async finalizeReturnIssuedAfterApply(
    attempt: AttemptRow,
  ): Promise<boolean> {
    if (attempt.kind !== RefundAttemptKind.RETURN || !attempt.returnRequestId) {
      return false;
    }
    if (attempt.status !== RefundAttemptStatus.APPLIED) {
      return false;
    }
    const updated = await this.prisma.returnRequest.updateMany({
      where: {
        id: attempt.returnRequestId,
        refundStatus: { not: ReturnRefundStatus.ISSUED },
      },
      data: {
        refundStatus: ReturnRefundStatus.ISSUED,
        refundedAt: new Date(),
      },
    });
    return updated.count > 0;
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
      const abandonGate = await this.abandonBlocksNewStripeCreateTx(tx, attempt);
      if (abandonGate.blocked) {
        return null;
      }
      if (
        attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
        attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
        attempt.status === RefundAttemptStatus.APPLIED ||
        attempt.status === RefundAttemptStatus.PERMANENTLY_FAILED ||
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

  /**
   * Abandon / PERMANENTLY_FAILED / RELEASED hold gate new Stripe creates and versions.
   * Does not block persistence of late success evidence or apply.
   */
  private async abandonBlocksNewStripeCreateTx(
    tx: Prisma.TransactionClient,
    attempt: {
      id: string;
      status: RefundAttemptStatus;
      returnRequestId: string | null;
      kind: RefundAttemptKind;
    },
  ): Promise<{ blocked: boolean; reason: string }> {
    if (attempt.status === RefundAttemptStatus.PERMANENTLY_FAILED) {
      return { blocked: true, reason: 'attempt_permanently_failed' };
    }
    if (attempt.kind !== RefundAttemptKind.RETURN || !attempt.returnRequestId) {
      return { blocked: false, reason: '' };
    }
    const rr = await tx.returnRequest.findUnique({
      where: { id: attempt.returnRequestId },
      select: { refundAbandonRequestedAt: true },
    });
    if (rr?.refundAbandonRequestedAt) {
      return { blocked: true, reason: 'return_abandon_requested' };
    }
    const hold = await tx.shipmentRefundHold.findUnique({
      where: { returnRequestId: attempt.returnRequestId },
      select: { status: true },
    });
    if (hold?.status === ShipmentRefundHoldStatus.RELEASED) {
      return { blocked: true, reason: 'hold_released' };
    }
    return { blocked: false, reason: '' };
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
      kind?: RefundAttemptKind;
      returnRequestId?: string | null;
      investigationReason?: string | null;
    },
  ): Promise<SubmissionRow> {
    const abandonGate = await this.abandonBlocksNewStripeCreateTx(tx, {
      id: attempt.id,
      status: attempt.status,
      returnRequestId: attempt.returnRequestId ?? null,
      kind: attempt.kind ?? RefundAttemptKind.RETURN,
    });
    if (
      abandonGate.blocked ||
      attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
      attempt.status === RefundAttemptStatus.STRIPE_SUCCEEDED ||
      attempt.status === RefundAttemptStatus.APPLIED ||
      attempt.status === RefundAttemptStatus.PERMANENTLY_FAILED ||
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
    return this.insertSubmissionVersionTx(
      this.prisma,
      attemptId,
      operationKey,
      version,
    );
  }

  private async insertSubmissionVersionTx(
    db: Prisma.TransactionClient | PrismaService,
    attemptId: string,
    operationKey: string,
    version: number,
  ): Promise<SubmissionRow> {
    const row = await db.refundAttemptSubmission.create({
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

  private async lockShipment(
    tx: Prisma.TransactionClient,
    shipmentId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "OrderShipment" WHERE id = ${shipmentId} FOR UPDATE
    `;
  }

  /**
   * RETURN clawback under the apply txn.
   * Verified no-commission no-op only when neither snapshot nor reservation exists.
   */
  private async applyReturnClawbackForAttempt(
    tx: Prisma.TransactionClient,
    params: {
      returnRequestId: string;
      orderItemId: string;
      actor: AuthUser;
    },
  ): Promise<void> {
    const reservation = await tx.commissionClawback.findUnique({
      where: { returnRequestId: params.returnRequestId },
    });
    const snapshot = await tx.orderItemCommission.findUnique({
      where: { orderItemId: params.orderItemId },
    });

    if (!reservation && !snapshot) {
      return;
    }
    if (!reservation && snapshot) {
      throw new ApplyInvariantError(
        'clawback_reservation_missing',
        'OrderItemCommission exists but CommissionClawback reservation is missing',
      );
    }

    const result = await this.ledger.applyReturnClawback(tx, {
      returnRequestId: params.returnRequestId,
      actor: params.actor,
    });

    if (result.legacy) {
      // Reservation vanished or never existed while we expected one — never fall back to clawbackForOrderItem.
      const stillMissing = !(await tx.commissionClawback.findUnique({
        where: { returnRequestId: params.returnRequestId },
      }));
      if (stillMissing && snapshot) {
        throw new ApplyInvariantError(
          'clawback_reservation_missing',
          'applyReturnClawback returned legacy while commission snapshot exists',
        );
      }
      if (stillMissing && !snapshot) {
        return;
      }
      throw new ApplyInvariantError(
        'clawback_legacy_unexpected',
        'applyReturnClawback returned legacy unexpectedly',
      );
    }

    if (!result.applied) {
      const current = await tx.commissionClawback.findUnique({
        where: { returnRequestId: params.returnRequestId },
      });
      if (current?.appliedAt) {
        return;
      }
      throw new ApplyInvariantError(
        'clawback_apply_noop_unexpected',
        'applyReturnClawback did not apply and reservation has no appliedAt',
      );
    }
  }

  /**
   * Conditional failure write — never matches APPLIED / appliedAt set.
   */
  private async recordApplyFailure(params: {
    refundAttemptId: string;
    error: unknown;
  }): Promise<void> {
    const invariant =
      params.error instanceof ApplyInvariantError ? params.error : null;
    const code = invariant?.code ?? 'apply_transaction_failed';
    const message =
      params.error instanceof Error
        ? params.error.message
        : String(params.error);
    const detail = sanitizeRefundErrorDetail({ code, message });

    if (invariant?.needsInvestigation) {
      await this.prisma.refundAttempt.updateMany({
        where: {
          id: params.refundAttemptId,
          appliedAt: null,
          status: {
            in: [
              RefundAttemptStatus.STRIPE_SUCCEEDED,
              RefundAttemptStatus.APPLY_FAILED,
              RefundAttemptStatus.NEEDS_INVESTIGATION,
            ],
          },
        },
        data: {
          status: RefundAttemptStatus.NEEDS_INVESTIGATION,
          investigationReason: truncateReason(code),
          applyError: detail,
          lastError: detail,
        },
      });
      return;
    }

    await this.prisma.refundAttempt.updateMany({
      where: {
        id: params.refundAttemptId,
        appliedAt: null,
        status: {
          in: [
            RefundAttemptStatus.STRIPE_SUCCEEDED,
            RefundAttemptStatus.APPLY_FAILED,
          ],
        },
      },
      data: {
        status: RefundAttemptStatus.APPLY_FAILED,
        applyError: detail,
        lastError: detail,
      },
    });
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
        attempt.status === RefundAttemptStatus.NEEDS_INVESTIGATION ||
        attempt.status === RefundAttemptStatus.PERMANENTLY_FAILED
      ) {
        return {
          attempt: asAttempt(attempt),
          submission: asSubmission(submission),
          classification: 'STALE_SUBMISSION_IGNORED' as const,
        };
      }

      const abandonGate = await this.abandonBlocksNewStripeCreateTx(tx, attempt);
      if (abandonGate.blocked) {
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
  orderItemId?: string | null;
  orderShipmentId?: string | null;
  supplierId?: string | null;
  actorUserId?: string;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amountCents: number;
  currency: string;
  shipmentRefundApplied?: boolean;
  clawbackAppliedAt?: Date | null;
  appliedAt?: Date | null;
  applyError?: string | null;
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
    orderItemId: row.orderItemId ?? null,
    orderShipmentId: row.orderShipmentId ?? null,
    supplierId: row.supplierId ?? null,
    actorUserId: row.actorUserId ?? '',
    stripePaymentIntentId: row.stripePaymentIntentId,
    stripeRefundId: row.stripeRefundId,
    amountCents: row.amountCents,
    currency: row.currency,
    shipmentRefundApplied: row.shipmentRefundApplied ?? false,
    clawbackAppliedAt: row.clawbackAppliedAt ?? null,
    appliedAt: row.appliedAt ?? null,
    applyError: row.applyError ?? null,
    lastError: row.lastError,
    investigationReason: row.investigationReason,
  };
}

function isTransientDbError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  if (
    code === 'P2034' ||
    code === 'P1001' ||
    code === 'P1017' ||
    code === 'P2024'
  ) {
    return true;
  }
  const message = String((error as Error).message ?? '');
  return /deadlock|could not serialize|connection (?:reset|refused|terminated)/i.test(
    message,
  );
}

/**
 * Fail closed before money movement: frozen amount must be finite and &gt; 0,
 * and amountCents must equal roundMoney(amount) in minor units.
 */
function resolveFrozenRefundAmount(attempt: {
  amount: unknown;
  amountCents: number;
}): number {
  const raw = Number(attempt.amount);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new ApplyInvariantError(
      'apply_amount_invalid',
      'Frozen RefundAttempt.amount must be finite and greater than zero',
      { needsInvestigation: true },
    );
  }
  const frozenAmount = roundMoney(raw);
  if (!Number.isFinite(frozenAmount) || frozenAmount <= 0) {
    throw new ApplyInvariantError(
      'apply_amount_invalid',
      'Frozen RefundAttempt.amount rounds to a non-positive value',
      { needsInvestigation: true },
    );
  }
  if (
    !Number.isInteger(attempt.amountCents) ||
    attempt.amountCents <= 0
  ) {
    throw new ApplyInvariantError(
      'apply_amount_cents_mismatch',
      'Frozen RefundAttempt.amountCents must be a positive integer',
      { needsInvestigation: true },
    );
  }
  const expectedCents = Math.round(frozenAmount * 100);
  if (attempt.amountCents !== expectedCents) {
    throw new ApplyInvariantError(
      'apply_amount_cents_mismatch',
      `Frozen amount ${frozenAmount} does not match amountCents ${attempt.amountCents} (expected ${expectedCents})`,
      { needsInvestigation: true },
    );
  }
  return frozenAmount;
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
