import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { utcWallClockIso } from './payment-reconcile-utc';

/** Default grace after stripeChargeAttemptAt before a PENDING card order may be leased. */
export const PAYMENT_RECONCILE_DEFAULT_GRACE_MS = 2 * 60 * 1000;

/** Default lease TTL once claimed. */
export const PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

export type PaymentReconcileClaimedOrder = {
  id: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  attemptCount: number;
  paymentMode: string;
  stripePaymentIntentId: string | null;
  stripeChargeAttemptAt: Date;
  paymentReconcileNextAt: Date | null;
};

export type ClaimEligibleBatchParams = {
  limit: number;
  /** Fixed clock for tests; defaults to Date.now(). */
  nowMs?: number;
  graceMs?: number;
  leaseTtlMs?: number;
};

/**
 * Short-transaction lease primitives for future stale-PENDING card reconciliation.
 * Does not call Stripe, change payment status, or touch stock.
 *
 * Timestamp convention: Order reconcile columns are TIMESTAMP WITHOUT TIME ZONE
 * storing UTC wall-clock components. Predicates bind ISO UTC strings via
 * `::timestamp` so session TimeZone cannot skew comparisons.
 */
@Injectable()
export class PaymentReconcileLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically claim up to `limit` eligible PENDING card orders.
   * Uses FOR UPDATE SKIP LOCKED; commits before return (no lock held for callers).
   */
  async claimEligibleBatch(
    params: ClaimEligibleBatchParams,
  ): Promise<PaymentReconcileClaimedOrder[]> {
    const limit = Math.max(0, Math.floor(params.limit));
    if (limit === 0) return [];

    const nowMs = params.nowMs ?? Date.now();
    const graceMs = params.graceMs ?? PAYMENT_RECONCILE_DEFAULT_GRACE_MS;
    const leaseTtlMs =
      params.leaseTtlMs ?? PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS;
    const nowIso = utcWallClockIso(nowMs);
    const graceIso = utcWallClockIso(nowMs - graceMs);
    const leaseExpiresIso = utcWallClockIso(nowMs + leaseTtlMs);

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM "Order"
        WHERE "paymentStatus" = 'PENDING'::"PaymentStatus"
          AND "paymentMode" IN ('test', 'live')
          AND "paymentReconcileManualReviewAt" IS NULL
          AND (
            "paymentReconcileNextAt" IS NULL
            OR "paymentReconcileNextAt" <= ${nowIso}::timestamp
          )
          AND (
            "paymentReconcileLeaseOwner" IS NULL
            OR "paymentReconcileLeaseExpiresAt" IS NULL
            OR "paymentReconcileLeaseExpiresAt" <= ${nowIso}::timestamp
          )
          AND "stripeChargeAttemptAt" IS NOT NULL
          AND "stripeChargeAttemptAt" <= ${graceIso}::timestamp
        ORDER BY
          COALESCE("paymentReconcileNextAt", "stripeChargeAttemptAt") ASC,
          id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;

      const claimed: PaymentReconcileClaimedOrder[] = [];
      for (const row of candidates) {
        const leaseOwner = randomUUID();
        // Write lease expiry as UTC wall clock via ::timestamp (not Prisma Date bind).
        const updated = await tx.$queryRaw<{ id: string }[]>`
          UPDATE "Order"
          SET
            "paymentReconcileLeaseOwner" = ${leaseOwner},
            "paymentReconcileLeaseExpiresAt" = ${leaseExpiresIso}::timestamp,
            "paymentReconcileAttemptCount" = "paymentReconcileAttemptCount" + 1
          WHERE id = ${row.id}
            AND "paymentStatus" = 'PENDING'::"PaymentStatus"
            AND "paymentReconcileManualReviewAt" IS NULL
          RETURNING id
        `;
        if (updated.length !== 1) continue;

        const order = await tx.order.findUnique({
          where: { id: row.id },
          select: {
            id: true,
            paymentMode: true,
            stripePaymentIntentId: true,
            stripeChargeAttemptAt: true,
            paymentReconcileNextAt: true,
            paymentReconcileLeaseOwner: true,
            paymentReconcileLeaseExpiresAt: true,
            paymentReconcileAttemptCount: true,
          },
        });
        if (
          !order ||
          !order.paymentReconcileLeaseOwner ||
          !order.paymentReconcileLeaseExpiresAt ||
          !order.stripeChargeAttemptAt
        ) {
          continue;
        }
        claimed.push({
          id: order.id,
          leaseOwner: order.paymentReconcileLeaseOwner,
          leaseExpiresAt: order.paymentReconcileLeaseExpiresAt,
          attemptCount: order.paymentReconcileAttemptCount,
          paymentMode: order.paymentMode,
          stripePaymentIntentId: order.stripePaymentIntentId,
          stripeChargeAttemptAt: order.stripeChargeAttemptAt,
          paymentReconcileNextAt: order.paymentReconcileNextAt,
        });
      }
      return claimed;
    });
  }

  /**
   * Prisma reads TIMESTAMP WITHOUT TIME ZONE as a Date whose UTC components match
   * the stored wall clock; epoch compare is then timezone-independent.
   */
  async isLeaseHeld(
    orderId: string,
    leaseOwner: string,
    nowMs: number = Date.now(),
  ): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        paymentReconcileLeaseOwner: true,
        paymentReconcileLeaseExpiresAt: true,
      },
    });
    if (!order) return false;
    if (order.paymentReconcileLeaseOwner !== leaseOwner) return false;
    if (!order.paymentReconcileLeaseExpiresAt) return false;
    return order.paymentReconcileLeaseExpiresAt.getTime() > nowMs;
  }

  /**
   * Extend lease expiry when still owned by `leaseOwner` and order is PENDING.
   * Expiry predicate uses UTC ISO ::timestamp (session-TZ safe).
   */
  async renewLease(params: {
    orderId: string;
    leaseOwner: string;
    nowMs?: number;
    leaseTtlMs?: number;
  }): Promise<boolean> {
    const nowMs = params.nowMs ?? Date.now();
    const leaseTtlMs =
      params.leaseTtlMs ?? PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS;
    const nowIso = utcWallClockIso(nowMs);
    const expiresIso = utcWallClockIso(nowMs + leaseTtlMs);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${expiresIso}::timestamp
      WHERE id = ${params.orderId}
        AND "paymentStatus" = 'PENDING'::"PaymentStatus"
        AND "paymentReconcileLeaseOwner" = ${params.leaseOwner}
        AND "paymentReconcileLeaseExpiresAt" > ${nowIso}::timestamp
      RETURNING id
    `;
    return rows.length === 1;
  }

  /**
   * Clear lease when token matches. Allowed for any paymentStatus so a worker
   * can drop a lease after observing a terminal transition. No time predicate.
   */
  async releaseLease(orderId: string, leaseOwner: string): Promise<boolean> {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        paymentReconcileLeaseOwner: leaseOwner,
      },
      data: {
        paymentReconcileLeaseOwner: null,
        paymentReconcileLeaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  /**
   * Schedule next reconcile attempt while still PENDING and lease-owned.
   */
  async scheduleNextAttempt(params: {
    orderId: string;
    leaseOwner: string;
    nextAt: Date;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = utcWallClockIso(nowMs);
    const nextIso = utcWallClockIso(params.nextAt.getTime());
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Order"
      SET "paymentReconcileNextAt" = ${nextIso}::timestamp
      WHERE id = ${params.orderId}
        AND "paymentStatus" = 'PENDING'::"PaymentStatus"
        AND "paymentReconcileLeaseOwner" = ${params.leaseOwner}
        AND "paymentReconcileLeaseExpiresAt" > ${nowIso}::timestamp
        AND "paymentReconcileManualReviewAt" IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  }

  /**
   * Escalate to manual review while still PENDING and lease-owned.
   */
  async markManualReview(params: {
    orderId: string;
    leaseOwner: string;
    nowMs?: number;
  }): Promise<boolean> {
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = utcWallClockIso(nowMs);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Order"
      SET
        "paymentReconcileManualReviewAt" = ${nowIso}::timestamp,
        "paymentReconcileLeaseOwner" = NULL,
        "paymentReconcileLeaseExpiresAt" = NULL
      WHERE id = ${params.orderId}
        AND "paymentStatus" = 'PENDING'::"PaymentStatus"
        AND "paymentReconcileLeaseOwner" = ${params.leaseOwner}
        AND "paymentReconcileLeaseExpiresAt" > ${nowIso}::timestamp
        AND "paymentReconcileManualReviewAt" IS NULL
      RETURNING id
    `;
    return rows.length === 1;
  }
}

/** Test helper: Prisma where fragment mirroring claim eligibility (without SKIP LOCKED). */
export function paymentReconcileEligibilityWhere(
  now: Date,
  graceDeadline: Date,
): Prisma.OrderWhereInput {
  return {
    paymentStatus: PaymentStatus.PENDING,
    paymentMode: { in: ['test', 'live'] },
    paymentReconcileManualReviewAt: null,
    stripeChargeAttemptAt: { not: null, lte: graceDeadline },
    AND: [
      {
        OR: [
          { paymentReconcileNextAt: null },
          { paymentReconcileNextAt: { lte: now } },
        ],
      },
      {
        OR: [
          { paymentReconcileLeaseOwner: null },
          { paymentReconcileLeaseExpiresAt: null },
          // Complement of live-lease `expiresAt > now` (same as claim SQL `<=`).
          { paymentReconcileLeaseExpiresAt: { lte: now } },
        ],
      },
    ],
  };
}
