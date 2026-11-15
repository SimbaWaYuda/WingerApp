import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  LegacyStripeEvidenceClassification,
  LegacyStripeEvidenceSource,
  LegacyStripeOutcome,
  Prisma,
  ReturnRefundDrive,
  ReturnRefundStatus,
  ShipmentRefundHoldStatus,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { CommissionLedgerService } from '../commissions/commission-ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  refundPaymentForSupplierAction,
  roundMoney,
  shipmentPaymentTotal,
} from './settlement-allocation';
import {
  amountToCentsExact,
  assertExactHundredthsAmount,
  availableShipmentRefundCapacity,
  isCardPaymentMode,
  selectReturnRefundDrive,
  ShipmentRefundHoldError,
  type LegacyStripeEvidenceClassificationName,
  type LegacyStripeEvidenceSourceName,
  type ShipmentRefundHoldProof,
} from './shipment-refund-hold.types';

export type ReserveHoldInput = {
  returnRequestId: string;
  orderShipmentId: string;
  supplierId: string;
  currency: string;
  returnedMerchandise: number;
  includeDelivery: boolean;
  siblingHadLiveLine: boolean;
  /** When ATTEMPT, link after attempt create. */
  refundAttemptId?: string | null;
};

export type ReservedHoldView = {
  id: string;
  returnRequestId: string;
  orderShipmentId: string;
  supplierId: string;
  amount: number;
  amountCents: number;
  currency: string;
  returnedMerchandise: number;
  includeDelivery: boolean;
  proofJson: ShipmentRefundHoldProof;
  status: ShipmentRefundHoldStatus;
  refundAttemptId: string | null;
  legacyStripeClaimedAt: Date | null;
  legacyStripeOutcome: LegacyStripeOutcome | null;
};

/**
 * Shared RETURN card-refund capacity holds (S2.3).
 * Lock order when used with attempts: ReturnRequest → RefundAttempt → OrderShipment → Hold.
 * LEGACY card finalize: ReturnRequest → OrderShipment → Hold.
 */
@Injectable()
export class ShipmentRefundHoldService {
  private readonly logger = new Logger(ShipmentRefundHoldService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CommissionLedgerService,
  ) {}

  selectDrive(paymentMode: string): 'ATTEMPT' | 'LEGACY' {
    return selectReturnRefundDrive({ paymentMode });
  }

  async lockReturnRequest(
    tx: Prisma.TransactionClient,
    returnRequestId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "ReturnRequest" WHERE id = ${returnRequestId} FOR UPDATE
    `;
  }

  async lockShipment(
    tx: Prisma.TransactionClient,
    shipmentId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "OrderShipment" WHERE id = ${shipmentId} FOR UPDATE
    `;
  }

  async lockHold(tx: Prisma.TransactionClient, holdId: string): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "ShipmentRefundHold" WHERE id = ${holdId} FOR UPDATE
    `;
  }

  async lockAttempt(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT id FROM "RefundAttempt" WHERE id = ${attemptId} FOR UPDATE
    `;
  }

  async sumReservedHolds(
    tx: Prisma.TransactionClient,
    orderShipmentId: string,
  ): Promise<number> {
    const agg = await tx.shipmentRefundHold.aggregate({
      where: {
        orderShipmentId,
        status: ShipmentRefundHoldStatus.RESERVED,
      },
      _sum: { amount: true },
    });
    return roundMoney(Number(agg._sum.amount ?? 0));
  }

  /**
   * Reserve capacity inside an open transaction.
   * Caller must already hold ReturnRequest FOR UPDATE, then we lock shipment.
   */
  async reserveInTransaction(
    tx: Prisma.TransactionClient,
    input: ReserveHoldInput,
  ): Promise<ReservedHoldView> {
    const existing = await tx.shipmentRefundHold.findUnique({
      where: { returnRequestId: input.returnRequestId },
    });
    if (existing) {
      if (existing.status === ShipmentRefundHoldStatus.RELEASED) {
        throw new ShipmentRefundHoldError(
          'hold_released',
          'ShipmentRefundHold was RELEASED and cannot be reactivated',
        );
      }
      return this.asView(existing);
    }

    await this.lockShipment(tx, input.orderShipmentId);
    const shipment = await tx.orderShipment.findUniqueOrThrow({
      where: { id: input.orderShipmentId },
    });
    if (shipment.supplierId !== input.supplierId) {
      throw new ShipmentRefundHoldError(
        'shipment_supplier_mismatch',
        'OrderShipment supplier does not match return supplier',
      );
    }

    const reservedBefore = await this.sumReservedHolds(tx, shipment.id);
    const refundedBefore = roundMoney(Number(shipment.refundedAmount));
    const paymentTotal = shipmentPaymentTotal({
      paymentMerchandise: Number(shipment.paymentMerchandise),
      paymentDelivery: Number(shipment.paymentDelivery),
      paymentTax: Number(shipment.paymentTax),
    });
    const available = availableShipmentRefundCapacity({
      paymentMerchandise: Number(shipment.paymentMerchandise),
      paymentDelivery: Number(shipment.paymentDelivery),
      paymentTax: Number(shipment.paymentTax),
      refundedAmount: refundedBefore,
      reservedHoldTotal: reservedBefore,
    });

    // Full business calculation — do not silently shrink to fit capacity.
    const calculated = refundPaymentForSupplierAction({
      shipment: {
        supplierId: shipment.supplierId,
        supplierName: shipment.supplierName,
        merchandise: Number(shipment.merchandise),
        deliveryFee: Number(shipment.deliveryFee),
        merchandiseTax: Number(shipment.merchandiseTax),
        deliveryTax: Number(shipment.deliveryTax),
        paymentMerchandise: Number(shipment.paymentMerchandise),
        paymentDelivery: Number(shipment.paymentDelivery),
        paymentTax: Number(shipment.paymentTax),
        // Capacity is enforced separately against reserved holds; do not double-cap here.
        refundedAmount: 0,
      },
      returnedMerchandise: input.returnedMerchandise,
      includeDelivery: input.includeDelivery,
    });
    const amount = assertExactHundredthsAmount(calculated);
    if (!(amount > 0)) {
      throw new ShipmentRefundHoldError(
        'insufficient_capacity',
        `Insufficient RETURN refund capacity on shipment (available ${available})`,
      );
    }
    if (amount - available > 0.001) {
      throw new ShipmentRefundHoldError(
        'insufficient_capacity',
        `Insufficient RETURN refund capacity on shipment (available ${available}, need ${amount})`,
      );
    }

    const amountCents = amountToCentsExact(amount);
    const currency = input.currency.toLowerCase();
    const proof: ShipmentRefundHoldProof = {
      version: 1,
      paymentMerchandise: Number(shipment.paymentMerchandise),
      paymentDelivery: Number(shipment.paymentDelivery),
      paymentTax: Number(shipment.paymentTax),
      merchandise: Number(shipment.merchandise),
      deliveryFee: Number(shipment.deliveryFee),
      merchandiseTax: Number(shipment.merchandiseTax),
      deliveryTax: Number(shipment.deliveryTax),
      returnedMerchandise: assertExactHundredthsAmount(
        input.returnedMerchandise,
      ),
      includeDelivery: input.includeDelivery,
      siblingLiveLineRule: 'no_other_live_sibling_same_supplier',
      siblingHadLiveLine: input.siblingHadLiveLine,
      shipmentPaymentTotal: paymentTotal,
      refundedAmountBefore: refundedBefore,
      reservedHoldTotalBefore: reservedBefore,
      calculatedRefundAmount: amount,
      calculatedRefundAmountCents: amountCents,
      currency,
      supplierId: input.supplierId,
      orderShipmentId: shipment.id,
      calculation: 'refundPaymentForSupplierAction',
    };

    const created = await tx.shipmentRefundHold.create({
      data: {
        returnRequestId: input.returnRequestId,
        orderShipmentId: shipment.id,
        supplierId: input.supplierId,
        amount: new Prisma.Decimal(amount.toFixed(2)),
        amountCents,
        currency,
        returnedMerchandise: new Prisma.Decimal(
          proof.returnedMerchandise.toFixed(2),
        ),
        includeDelivery: input.includeDelivery,
        proofJson: proof as unknown as Prisma.InputJsonValue,
        status: ShipmentRefundHoldStatus.RESERVED,
        refundAttemptId: input.refundAttemptId ?? null,
      },
    });
    return this.asView(created);
  }

  /**
   * Soft abandon request. Does not release capacity.
   * Lock: ReturnRequest (and Attempt when present).
   */
  async requestAbandonment(params: {
    returnRequestId: string;
  }): Promise<{ refundAbandonRequestedAt: Date }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockReturnRequest(tx, params.returnRequestId);
      const row = await tx.returnRequest.findUniqueOrThrow({
        where: { id: params.returnRequestId },
      });
      if (row.refundStatus === ReturnRefundStatus.ISSUED) {
        throw new BadRequestException(
          'Cannot abandon an already ISSUED return refund',
        );
      }
      const at = row.refundAbandonRequestedAt ?? new Date();
      if (!row.refundAbandonRequestedAt) {
        await tx.returnRequest.update({
          where: { id: row.id },
          data: { refundAbandonRequestedAt: at },
        });
      }

      if (row.refundDrive === ReturnRefundDrive.ATTEMPT) {
        const attempt = await tx.refundAttempt.findFirst({
          where: { returnRequestId: row.id },
          orderBy: { createdAt: 'asc' },
        });
        if (attempt) {
          await this.lockAttempt(tx, attempt.id);
        }
        await this.tryReleaseAttemptHoldTx(tx, row.id);
      } else if (row.refundDrive === ReturnRefundDrive.LEGACY) {
        await this.tryReleaseLegacyHoldTx(tx, row.id);
      }

      return { refundAbandonRequestedAt: at };
    });
  }

  /**
   * Release ATTEMPT hold only when abandon requested and every submission is
   * definitively terminal with no success / in-flight / ambiguous residual.
   */
  async tryReleaseAttemptHoldTx(
    tx: Prisma.TransactionClient,
    returnRequestId: string,
  ): Promise<'released' | 'retained' | 'absent'> {
    const rr = await tx.returnRequest.findUniqueOrThrow({
      where: { id: returnRequestId },
    });
    if (!rr.refundAbandonRequestedAt) return 'retained';

    const hold = await tx.shipmentRefundHold.findUnique({
      where: { returnRequestId },
    });
    if (!hold) return 'absent';
    if (hold.status !== ShipmentRefundHoldStatus.RESERVED) return 'retained';

    // Lock order: ReturnRequest (caller) → RefundAttempt → OrderShipment → Hold
    if (hold.refundAttemptId) {
      await this.lockAttempt(tx, hold.refundAttemptId);
    }
    await this.lockShipment(tx, hold.orderShipmentId);
    await this.lockHold(tx, hold.id);
    const lockedHold = await tx.shipmentRefundHold.findUniqueOrThrow({
      where: { id: hold.id },
    });
    if (lockedHold.status !== ShipmentRefundHoldStatus.RESERVED) {
      return 'retained';
    }

    if (!lockedHold.refundAttemptId) {
      // ATTEMPT drive without linked attempt — retain (cannot prove no future create).
      return 'retained';
    }
    const attempt = await tx.refundAttempt.findUniqueOrThrow({
      where: { id: lockedHold.refundAttemptId },
    });
    const submissions = await tx.refundAttemptSubmission.findMany({
      where: { refundAttemptId: attempt.id },
      orderBy: { version: 'asc' },
    });

    if (attempt.stripeRefundId) return 'retained';
    if (
      attempt.status === 'STRIPE_SUCCEEDED' ||
      attempt.status === 'APPLIED' ||
      attempt.status === 'APPLY_FAILED' ||
      attempt.status === 'NEEDS_INVESTIGATION' ||
      attempt.status === 'SUBMISSION_UNKNOWN'
    ) {
      return 'retained';
    }

    for (const sub of submissions) {
      if (sub.stripeRefundId) return 'retained';
      if (sub.outcome === 'SUCCEEDED') return 'retained';
      if (sub.outcome === 'SUBMISSION_UNKNOWN') return 'retained';
      if (sub.reconciliationResult === 'AMBIGUOUS') return 'retained';
      if (sub.outcome === 'PENDING' && sub.submittedAt) return 'retained';
      // PENDING never submitted is ok if abandon blocks future creates.
      if (
        sub.outcome !== 'FAILED' &&
        sub.outcome !== 'SUPERSEDED_BY_NO_MATCH' &&
        !(sub.outcome === 'PENDING' && !sub.submittedAt)
      ) {
        return 'retained';
      }
      if (
        sub.outcome === 'FAILED' &&
        sub.reconciliationResult !== 'MATCHED' &&
        sub.reconciliationResult !== 'NO_MATCH'
      ) {
        // Failed without definitive reconcile — retain.
        if (sub.submittedAt) return 'retained';
      }
    }

    await tx.shipmentRefundHold.update({
      where: { id: lockedHold.id },
      data: { status: ShipmentRefundHoldStatus.RELEASED },
    });
    // Prior guards already rejected success / apply / investigation statuses.
    await tx.refundAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'PERMANENTLY_FAILED',
        lastError: 'abandoned_hold_released',
      },
    });
    return 'released';
  }

  async tryReleaseLegacyHoldTx(
    tx: Prisma.TransactionClient,
    returnRequestId: string,
  ): Promise<'released' | 'retained' | 'absent' | 'finalize_needed'> {
    const rr = await tx.returnRequest.findUniqueOrThrow({
      where: { id: returnRequestId },
    });
    if (!rr.refundAbandonRequestedAt) return 'retained';

    const hold = await tx.shipmentRefundHold.findUnique({
      where: { returnRequestId },
    });
    if (!hold) return 'absent';
    if (hold.status !== ShipmentRefundHoldStatus.RESERVED) return 'retained';

    await this.lockShipment(tx, hold.orderShipmentId);
    await this.lockHold(tx, hold.id);
    const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
      where: { id: hold.id },
    });
    if (locked.status !== ShipmentRefundHoldStatus.RESERVED) return 'retained';

    if (locked.legacyStripeOutcome === LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE) {
      return 'finalize_needed';
    }
    if (locked.legacyStripeClaimedAt && locked.legacyStripeOutcome == null) {
      // Unresolved claim — never release.
      return 'retained';
    }
    if (
      locked.legacyStripeClaimedAt &&
      locked.legacyStripeOutcome !== LegacyStripeOutcome.FAILED_TERMINAL
    ) {
      return 'retained';
    }

    // No claim, or FAILED_TERMINAL — safe to release when abandon requested.
    await tx.shipmentRefundHold.update({
      where: { id: locked.id },
      data: { status: ShipmentRefundHoldStatus.RELEASED },
    });
    return 'released';
  }

  /**
   * LEGACY: claim Stripe slot before network call.
   * Lock: ReturnRequest → OrderShipment → Hold.
   */
  async claimLegacyStripeBeforeNetwork(params: {
    returnRequestId: string;
  }): Promise<ReservedHoldView & { freshClaim: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockReturnRequest(tx, params.returnRequestId);
      const rr = await tx.returnRequest.findUniqueOrThrow({
        where: { id: params.returnRequestId },
      });
      if (rr.refundStatus === ReturnRefundStatus.ISSUED) {
        throw new BadRequestException('Return refund already ISSUED');
      }
      if (rr.refundAbandonRequestedAt) {
        const hold = await tx.shipmentRefundHold.findUnique({
          where: { returnRequestId: rr.id },
        });
        if (
          hold?.legacyStripeOutcome ===
          LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE
        ) {
          return { ...this.asView(hold), freshClaim: false };
        }
        throw new BadRequestException(
          'Return refund abandonment requested; new LEGACY Stripe claim blocked',
        );
      }
      if (rr.refundDrive !== ReturnRefundDrive.LEGACY) {
        throw new ShipmentRefundHoldError(
          'drive_not_legacy',
          'LEGACY Stripe claim requires LEGACY ownership',
        );
      }

      const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: rr.id },
      });
      await this.lockShipment(tx, hold.orderShipmentId);
      await this.lockHold(tx, hold.id);
      const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { id: hold.id },
      });

      if (locked.status === ShipmentRefundHoldStatus.RELEASED) {
        throw new ShipmentRefundHoldError(
          'hold_released',
          'Cannot claim Stripe on a RELEASED hold',
        );
      }
      if (locked.status === ShipmentRefundHoldStatus.CONSUMED) {
        return { ...this.asView(locked), freshClaim: false };
      }
      if (
        locked.legacyStripeClaimedAt &&
        locked.legacyStripeOutcome == null
      ) {
        // Unresolved prior claim — reuse; caller must list-reconcile before create.
        return { ...this.asView(locked), freshClaim: false };
      }
      if (
        locked.legacyStripeOutcome ===
        LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE
      ) {
        return { ...this.asView(locked), freshClaim: false };
      }
      if (
        locked.legacyStripeOutcome === LegacyStripeOutcome.FAILED_TERMINAL
      ) {
        throw new ShipmentRefundHoldError(
          'legacy_failed_terminal',
          'LEGACY Stripe outcome is FAILED_TERMINAL; no new claim without product retry rules',
        );
      }

      const updated = await tx.shipmentRefundHold.update({
        where: { id: locked.id },
        data: {
          legacyStripeClaimedAt: new Date(),
          legacyStripeOutcome: null,
        },
      });
      return { ...this.asView(updated), freshClaim: true };
    });
  }

  async recordLegacyStripeOutcome(params: {
    returnRequestId: string;
    outcome: 'SUCCESS_PENDING_FINALIZE' | 'FAILED_TERMINAL' | null;
  }): Promise<ReservedHoldView> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockReturnRequest(tx, params.returnRequestId);
      const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: params.returnRequestId },
      });
      await this.lockShipment(tx, hold.orderShipmentId);
      await this.lockHold(tx, hold.id);
      const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { id: hold.id },
      });
      if (locked.status !== ShipmentRefundHoldStatus.RESERVED) {
        return this.asView(locked);
      }
      if (
        locked.legacyStripeOutcome ===
        LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE
      ) {
        return this.asView(locked);
      }
      const updated = await tx.shipmentRefundHold.update({
        where: { id: locked.id },
        data: {
          legacyStripeOutcome:
            params.outcome === 'SUCCESS_PENDING_FINALIZE'
              ? LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE
              : params.outcome === 'FAILED_TERMINAL'
                ? LegacyStripeOutcome.FAILED_TERMINAL
                : null,
        },
      });
      return this.asView(updated);
    });
  }

  /**
   * Append-only LEGACY Stripe observation. Never mutates proofJson or hold status.
   * Late success after RELEASED: evidence commits first, then fail-closed outside the txn.
   */
  async appendLegacyStripeEvidence(params: {
    returnRequestId: string;
    stripePaymentIntentId: string;
    stripeRefundId?: string | null;
    stripeStatus?: string | null;
    source: LegacyStripeEvidenceSourceName;
    classification: LegacyStripeEvidenceClassificationName;
    message?: string | null;
  }): Promise<{
    hold: ReservedHoldView;
    evidenceId: string;
    lateSuccessAfterReleased: boolean;
  }> {
    const committed = await this.prisma.$transaction(async (tx) => {
      await this.lockReturnRequest(tx, params.returnRequestId);
      const rr = await tx.returnRequest.findUniqueOrThrow({
        where: { id: params.returnRequestId },
        include: {
          order: { select: { stripePaymentIntentId: true } },
        },
      });
      const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: params.returnRequestId },
      });
      if (hold.returnRequestId !== params.returnRequestId) {
        throw new ShipmentRefundHoldError(
          'legacy_evidence_return_mismatch',
          'LEGACY evidence returnRequestId does not match hold',
        );
      }
      const orderPi = rr.order.stripePaymentIntentId;
      if (!orderPi || orderPi !== params.stripePaymentIntentId) {
        throw new ShipmentRefundHoldError(
          'legacy_evidence_pi_mismatch',
          'LEGACY evidence PaymentIntent does not match the return order',
        );
      }

      await this.lockShipment(tx, hold.orderShipmentId);
      await this.lockHold(tx, hold.id);
      const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { id: hold.id },
      });

      let classification = params.classification;
      const lateSuccessAfterReleased =
        locked.status === ShipmentRefundHoldStatus.RELEASED &&
        (classification === 'SUCCEEDED' ||
          classification === 'LATE_SUCCESS_AFTER_RELEASED');
      if (lateSuccessAfterReleased) {
        classification = 'LATE_SUCCESS_AFTER_RELEASED';
      }

      const evidence = await tx.shipmentRefundHoldLegacyEvidence.create({
        data: {
          shipmentRefundHoldId: locked.id,
          returnRequestId: params.returnRequestId,
          stripePaymentIntentId: params.stripePaymentIntentId,
          stripeRefundId: params.stripeRefundId ?? null,
          stripeStatus: params.stripeStatus ?? null,
          source:
            params.source === 'FRESH_CREATE'
              ? LegacyStripeEvidenceSource.FRESH_CREATE
              : LegacyStripeEvidenceSource.RECOVERY_LIST,
          classification:
            LegacyStripeEvidenceClassification[classification],
          message: params.message ?? null,
        },
      });

      // Never reactivate/consume via evidence writes. Do not throw here —
      // the insert must commit before fail-closed signaling.
      return {
        hold: this.asView(locked),
        evidenceId: evidence.id,
        lateSuccessAfterReleased,
        holdId: locked.id,
      };
    });

    if (committed.lateSuccessAfterReleased) {
      this.logger.error(
        `LEGACY late Stripe success after RELEASED hold ${committed.holdId} return ${params.returnRequestId} refund ${params.stripeRefundId ?? 'none'} — investigation required (evidence ${committed.evidenceId} committed)`,
      );
      throw new ShipmentRefundHoldError(
        'legacy_late_success_after_released',
        'LEGACY Stripe success observed after hold RELEASED; evidence retained for investigation',
      );
    }

    return {
      hold: committed.hold,
      evidenceId: committed.evidenceId,
      lateSuccessAfterReleased: false,
    };
  }

  /**
   * LEGACY card atomic finalisation after SUCCESS_PENDING_FINALIZE.
   * Lock: ReturnRequest → OrderShipment → Hold → clawback.
   * Does not call Stripe or Connect reverse.
   */
  async finalizeLegacySuccessfulRefund(params: {
    returnRequestId: string;
    actor: AuthUser;
  }): Promise<{
    hold: ReservedHoldView;
    idempotent: boolean;
    legacyClawback: boolean;
  }> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockReturnRequest(tx, params.returnRequestId);
      const rr = await tx.returnRequest.findUniqueOrThrow({
        where: { id: params.returnRequestId },
      });
      const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: rr.id },
      });
      await this.lockShipment(tx, hold.orderShipmentId);
      await this.lockHold(tx, hold.id);
      const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { id: hold.id },
      });

      if (
        locked.status === ShipmentRefundHoldStatus.CONSUMED &&
        rr.refundStatus === ReturnRefundStatus.ISSUED
      ) {
        return {
          hold: this.asView(locked),
          idempotent: true,
          legacyClawback: false,
        };
      }
      if (locked.status === ShipmentRefundHoldStatus.RELEASED) {
        throw new ShipmentRefundHoldError(
          'hold_released',
          'Cannot finalise a RELEASED hold; operational incident if external success exists',
        );
      }
      if (
        locked.legacyStripeOutcome !==
        LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE
      ) {
        throw new ShipmentRefundHoldError(
          'legacy_not_pending_finalize',
          'LEGACY finalise requires SUCCESS_PENDING_FINALIZE',
        );
      }
      if (locked.status !== ShipmentRefundHoldStatus.RESERVED) {
        throw new ShipmentRefundHoldError(
          'hold_not_reserved',
          'LEGACY finalise requires RESERVED hold',
        );
      }

      const amount = assertExactHundredthsAmount(Number(locked.amount));
      const shipment = await tx.orderShipment.findUniqueOrThrow({
        where: { id: locked.orderShipmentId },
      });
      const next = roundMoney(Number(shipment.refundedAmount) + amount);
      const paymentTotal = shipmentPaymentTotal({
        paymentMerchandise: Number(shipment.paymentMerchandise),
        paymentDelivery: Number(shipment.paymentDelivery),
        paymentTax: Number(shipment.paymentTax),
      });
      if (next - paymentTotal > 0.001) {
        throw new ShipmentRefundHoldError(
          'shipment_refund_capacity',
          'Finalise would exceed shipment payment capacity',
        );
      }

      await tx.orderShipment.update({
        where: { id: shipment.id },
        data: {
          refundedAmount: new Prisma.Decimal(next.toFixed(2)),
        },
      });
      await tx.shipmentRefundHold.update({
        where: { id: locked.id },
        data: { status: ShipmentRefundHoldStatus.CONSUMED },
      });

      const clawback = await this.ledger.applyReturnClawback(tx, {
        returnRequestId: rr.id,
        actor: params.actor,
      });

      await tx.returnRequest.update({
        where: { id: rr.id },
        data: {
          refundStatus: ReturnRefundStatus.ISSUED,
          refundedAt: rr.refundedAt ?? new Date(),
        },
      });

      const consumed = await tx.shipmentRefundHold.findUniqueOrThrow({
        where: { id: locked.id },
      });
      return {
        hold: this.asView(consumed),
        idempotent: false,
        legacyClawback: clawback.legacy === true,
      };
    });
  }

  /**
   * Consume hold during ATTEMPT apply (caller holds Attempt → Shipment locks).
   * Does not lock ReturnRequest.
   */
  async consumeHoldForApplyTx(
    tx: Prisma.TransactionClient,
    params: {
      returnRequestId: string;
      refundAttemptId: string;
      expectedAmount: number;
      expectedAmountCents: number;
      expectedCurrency: string;
      orderShipmentId: string;
    },
  ): Promise<{ consumed: boolean; alreadyConsumed: boolean }> {
    const hold = await tx.shipmentRefundHold.findUnique({
      where: { returnRequestId: params.returnRequestId },
    });
    if (!hold) {
      throw new ShipmentRefundHoldError(
        'hold_missing',
        'ShipmentRefundHold required for ATTEMPT apply',
      );
    }
    await this.lockHold(tx, hold.id);
    const locked = await tx.shipmentRefundHold.findUniqueOrThrow({
      where: { id: hold.id },
    });

    if (locked.status === ShipmentRefundHoldStatus.CONSUMED) {
      return { consumed: false, alreadyConsumed: true };
    }
    if (locked.status === ShipmentRefundHoldStatus.RELEASED) {
      throw new ShipmentRefundHoldError(
        'hold_released',
        'Cannot consume a RELEASED hold after unexpected external success; fail closed',
      );
    }
    if (locked.orderShipmentId !== params.orderShipmentId) {
      throw new ShipmentRefundHoldError(
        'hold_shipment_mismatch',
        'Hold shipment does not match attempt shipment',
      );
    }
    if (
      locked.refundAttemptId &&
      locked.refundAttemptId !== params.refundAttemptId
    ) {
      throw new ShipmentRefundHoldError(
        'hold_attempt_mismatch',
        'Hold is linked to a different RefundAttempt',
      );
    }
    if (Number(locked.amount) !== params.expectedAmount) {
      throw new ShipmentRefundHoldError(
        'hold_amount_mismatch',
        'Frozen hold amount does not match attempt amount',
      );
    }
    if (locked.amountCents !== params.expectedAmountCents) {
      throw new ShipmentRefundHoldError(
        'hold_amount_cents_mismatch',
        'Frozen hold amountCents does not match attempt',
      );
    }
    if (locked.currency.toLowerCase() !== params.expectedCurrency.toLowerCase()) {
      throw new ShipmentRefundHoldError(
        'hold_currency_mismatch',
        'Frozen hold currency does not match attempt',
      );
    }

    await tx.shipmentRefundHold.update({
      where: { id: locked.id },
      data: {
        status: ShipmentRefundHoldStatus.CONSUMED,
        refundAttemptId: locked.refundAttemptId ?? params.refundAttemptId,
      },
    });
    return { consumed: true, alreadyConsumed: false };
  }

  asView(row: {
    id: string;
    returnRequestId: string;
    orderShipmentId: string;
    supplierId: string;
    amount: Prisma.Decimal | number;
    amountCents: number;
    currency: string;
    returnedMerchandise: Prisma.Decimal | number;
    includeDelivery: boolean;
    proofJson: Prisma.JsonValue;
    status: ShipmentRefundHoldStatus;
    refundAttemptId: string | null;
    legacyStripeClaimedAt: Date | null;
    legacyStripeOutcome: LegacyStripeOutcome | null;
  }): ReservedHoldView {
    return {
      id: row.id,
      returnRequestId: row.returnRequestId,
      orderShipmentId: row.orderShipmentId,
      supplierId: row.supplierId,
      amount: Number(row.amount),
      amountCents: row.amountCents,
      currency: row.currency,
      returnedMerchandise: Number(row.returnedMerchandise),
      includeDelivery: row.includeDelivery,
      proofJson: row.proofJson as unknown as ShipmentRefundHoldProof,
      status: row.status,
      refundAttemptId: row.refundAttemptId,
      legacyStripeClaimedAt: row.legacyStripeClaimedAt,
      legacyStripeOutcome: row.legacyStripeOutcome,
    };
  }

  requiresCardHold(paymentMode: string): boolean {
    return isCardPaymentMode(paymentMode);
  }
}
