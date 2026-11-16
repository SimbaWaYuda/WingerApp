import { Injectable } from '@nestjs/common';
import { PaymentReconcileManualReviewReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { utcWallClockIso } from './payment-reconcile-utc';

/** Age after Order.createdAt before a structurally unleaseable PENDING card may escalate. */
export const PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS = 30 * 60 * 1000;

export const PAYMENT_RECONCILE_ESCALATE_DEFAULT_BATCH = 50;

export type EscalateUnleaseableResult = {
  escalated: number;
  byReason: {
    MISSING_ATTEMPT_AT: number;
    INCONSISTENT_ATTEMPT_AT: number;
  };
  orderIds: string[];
};

export type EscalateUnleaseableParams = {
  batchSize?: number;
  /** Fixed clock for tests; defaults to Date.now(). */
  nowMs?: number;
  /** Override age threshold; defaults to PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS. */
  ageMs?: number;
};

/**
 * Escalates structurally unleaseable PENDING card orders to manual review.
 * Does not call Stripe, change payment status, or touch stock.
 *
 * Writable reasons in this stage: MISSING_ATTEMPT_AT, INCONSISTENT_ATTEMPT_AT only.
 * RETRY_EXHAUSTED / SEARCH_* are reserved for the future reconciliation worker.
 */
@Injectable()
export class PaymentReconcileEscalateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically escalate up to `batchSize` eligible orders.
   * Short transaction with FOR UPDATE SKIP LOCKED; no external I/O while locked.
   */
  async escalateUnleaseableOrders(
    params: EscalateUnleaseableParams = {},
  ): Promise<EscalateUnleaseableResult> {
    const batchSize = Math.max(
      0,
      Math.floor(params.batchSize ?? PAYMENT_RECONCILE_ESCALATE_DEFAULT_BATCH),
    );
    const empty: EscalateUnleaseableResult = {
      escalated: 0,
      byReason: { MISSING_ATTEMPT_AT: 0, INCONSISTENT_ATTEMPT_AT: 0 },
      orderIds: [],
    };
    if (batchSize === 0) return empty;

    const nowMs = params.nowMs ?? Date.now();
    const ageMs =
      params.ageMs ?? PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS;
    const nowIso = utcWallClockIso(nowMs);
    const ageDeadlineIso = utcWallClockIso(nowMs - ageMs);

    const missing = PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT;
    const inconsistent =
      PaymentReconcileManualReviewReason.INCONSISTENT_ATTEMPT_AT;

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<
        { id: string; reason: PaymentReconcileManualReviewReason }[]
      >`
        SELECT id,
          CASE
            WHEN "stripeChargeAttemptAt" IS NULL
              THEN ${missing}::"PaymentReconcileManualReviewReason"
            ELSE ${inconsistent}::"PaymentReconcileManualReviewReason"
          END AS reason
        FROM "Order"
        WHERE "paymentStatus" = 'PENDING'::"PaymentStatus"
          AND "paymentMode" IN ('test', 'live')
          AND "paymentReconcileManualReviewAt" IS NULL
          AND "createdAt" <= ${ageDeadlineIso}::timestamp
          AND (
            "stripeChargeAttemptAt" IS NULL
            OR "stripeChargeAttemptAt" > ${nowIso}::timestamp
          )
          AND (
            "paymentReconcileLeaseOwner" IS NULL
            OR "paymentReconcileLeaseExpiresAt" IS NULL
            OR "paymentReconcileLeaseExpiresAt" <= ${nowIso}::timestamp
          )
        ORDER BY "createdAt" ASC, id ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      const byReason = {
        MISSING_ATTEMPT_AT: 0,
        INCONSISTENT_ATTEMPT_AT: 0,
      };
      const orderIds: string[] = [];

      for (const row of candidates) {
        if (
          row.reason !== missing &&
          row.reason !== inconsistent
        ) {
          continue;
        }
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "Order"
          SET
            "paymentReconcileManualReviewAt" = ${nowIso}::timestamp,
            "paymentReconcileManualReviewReason" = ${row.reason}::"PaymentReconcileManualReviewReason",
            "paymentReconcileLeaseOwner" = NULL,
            "paymentReconcileLeaseExpiresAt" = NULL
          WHERE id = ${row.id}
            AND "paymentStatus" = 'PENDING'::"PaymentStatus"
            AND "paymentReconcileManualReviewAt" IS NULL
          RETURNING id
        `;
        if (updated.length !== 1) continue;
        orderIds.push(row.id);
        if (row.reason === missing) byReason.MISSING_ATTEMPT_AT += 1;
        else byReason.INCONSISTENT_ATTEMPT_AT += 1;
      }

      return {
        escalated: orderIds.length,
        byReason,
        orderIds,
      };
    });
  }
}
