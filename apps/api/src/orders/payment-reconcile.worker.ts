import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
  PAYMENT_RECONCILE_MAX_CLAIMS,
  PaymentReconcileClaimedOrder,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import { StripeService } from './stripe.service';

/** Exact env gate (must be the string "1"). */
export const PAYMENT_RECONCILE_WORKER_ENV = 'PAYMENT_RECONCILE_WORKER_ENABLED';

export const PAYMENT_RECONCILE_WORKER_POLL_MS = 30_000;
export const PAYMENT_RECONCILE_WORKER_CONCURRENCY = 3;
export const PAYMENT_RECONCILE_WORKER_RENEW_MS = 90_000;
export const PAYMENT_RECONCILE_WORKER_DRAIN_MS = 120_000;

/**
 * After drain deadline + invalidate, briefly await abandoned task finally blocks
 * (renew chain + token release). Does not await tickChain or in-flight claims.
 * Prisma claimEligibleBatch cannot be cancelled; late results are released in
 * the detached fill path.
 */
export const PAYMENT_RECONCILE_WORKER_SHUTDOWN_CLEANUP_MS = 5_000;

const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 2 * 60 * 1000;

export function isPaymentReconcileWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env[PAYMENT_RECONCILE_WORKER_ENV] ?? '').trim() === '1';
}

/** Approved backoff: min(6h, 2^(attempt-1) × 2m). */
export function paymentReconcileBackoffMs(attemptCount: number): number {
  const attempt = Math.max(1, Math.floor(attemptCount));
  const raw = 2 ** (attempt - 1) * BACKOFF_BASE_MS;
  return Math.min(BACKOFF_CAP_MS, raw);
}

export type PaymentReconcileWorkContext = {
  order: PaymentReconcileClaimedOrder;
  /** When true, local work is abandoned; terminal applicators must not run. */
  readonly invalidated: boolean;
  invalidate: () => void;
  /** Gate for future terminal DB mutations (fence still mandatory). */
  canApplyTerminal: () => boolean;
};

/**
 * Bound PaymentIntent processor (S2.6.20.9) or test doubles.
 * When null, fillSlots never claims (protects attempt counts).
 */
export type PaymentReconcileOrderProcessor = (
  ctx: PaymentReconcileWorkContext,
) => Promise<void>;

type InFlightEntry = {
  ctx: PaymentReconcileWorkContext;
  done: Promise<void>;
};

/**
 * Payment reconciliation worker shell (S2.6.20.8 / 8b).
 * Slot-based claims, single-flight fill, renewals, bounded drain shutdown.
 */
@Injectable()
export class PaymentReconcileWorker
  implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PaymentReconcileWorker.name);
  private processor: PaymentReconcileOrderProcessor | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private active = false;
  private drainPromise: Promise<void> | null = null;
  private drainMs = PAYMENT_RECONCILE_WORKER_DRAIN_MS;
  private renewMs = PAYMENT_RECONCILE_WORKER_RENEW_MS;
  private cleanupMs = PAYMENT_RECONCILE_WORKER_SHUTDOWN_CLEANUP_MS;
  private readonly inFlight = new Map<string, InFlightEntry>();
  /** Serializes poll ticks (does not bound shutdown). */
  private tickChain: Promise<void> = Promise.resolve();
  /** Shared single-flight fill — production tick and tests use the same guard. */
  private fillInFlight: Promise<void> | null = null;

  constructor(
    private readonly lease: PaymentReconcileLeaseService,
    private readonly stripe: StripeService,
  ) {}

  /** Test-only timing overrides (production uses locked defaults). */
  setTimingForTests(opts: {
    drainMs?: number;
    renewMs?: number;
    cleanupMs?: number;
  }): void {
    if (opts.drainMs != null) this.drainMs = opts.drainMs;
    if (opts.renewMs != null) this.renewMs = opts.renewMs;
    if (opts.cleanupMs != null) this.cleanupMs = opts.cleanupMs;
  }

  /**
   * Production BoundProcessor wires itself here before worker activation.
   * Tests inject doubles via the same hook.
   */
  setProcessor(processor: PaymentReconcileOrderProcessor | null): void {
    this.processor = processor;
  }

  get isActive(): boolean {
    return this.active;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** True while a fillSlots body is running (including awaiting claim). */
  get isFillInFlight(): boolean {
    return this.fillInFlight != null;
  }

  onModuleInit(): void {
    if (!isPaymentReconcileWorkerEnabled()) {
      return;
    }
    if (!this.stripe.configured) {
      this.logger.error(
        'PAYMENT_RECONCILE_WORKER_ENABLED=1 but Stripe is demo/unconfigured; ' +
          'reconciliation worker remains inactive (no claims)',
      );
      return;
    }
    if (!this.processor) {
      this.logger.error(
        'PAYMENT_RECONCILE_WORKER_ENABLED=1 but no bound processor is wired; ' +
          'reconciliation worker remains inactive (no claims)',
      );
      return;
    }
    this.active = true;
    this.shuttingDown = false;
    this.pollTimer = setInterval(() => {
      this.enqueueTick();
    }, PAYMENT_RECONCILE_WORKER_POLL_MS);
    this.pollTimer.unref?.();
    this.enqueueTick();
  }

  async onModuleDestroy(): Promise<void> {
    await this.beginShutdownAndDrain();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.beginShutdownAndDrain();
  }

  /**
   * Exposed for tests: same fill guard as production ticks.
   * Still respects shutdown and the processor gate.
   */
  async tickForTests(): Promise<void> {
    await this.requestFill();
  }

  /** Exposed for tests: force shutdown/drain path. */
  async shutdownForTests(): Promise<void> {
    await this.beginShutdownAndDrain();
  }

  private enqueueTick(): void {
    this.tickChain = this.tickChain
      .then(() => this.tick())
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'unknown';
        this.logger.warn(`Payment reconcile worker tick failed: ${message}`);
      });
  }

  private async tick(): Promise<void> {
    if (this.shuttingDown || !this.active) return;
    await this.requestFill();
  }

  /**
   * Single-flight fill: concurrent callers coalesce onto one in-flight fill.
   * Does not queue unbounded follow-up fills — callers must request again.
   */
  private async requestFill(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.fillInFlight) {
      await this.fillInFlight;
      return;
    }
    const run = this.fillSlotsBody().finally(() => {
      if (this.fillInFlight === run) {
        this.fillInFlight = null;
      }
    });
    this.fillInFlight = run;
    await run;
  }

  private freeSlots(): number {
    return Math.max(
      0,
      PAYMENT_RECONCILE_WORKER_CONCURRENCY - this.inFlight.size,
    );
  }

  private async fillSlotsBody(): Promise<void> {
    if (this.shuttingDown) return;
    // No processor → never claim (protects attempt counts).
    if (!this.processor) return;

    const free = this.freeSlots();
    if (free <= 0) return;

    let claimed: PaymentReconcileClaimedOrder[] = [];
    try {
      claimed = await this.lease.claimEligibleBatch({
        limit: free,
        leaseTtlMs: PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`Payment reconcile claim failed: ${message}`);
      return;
    }

    // Late claim after shutdown / deadline: never start processing; always release.
    for (const order of claimed) {
      if (this.shuttingDown) {
        await this.safeReleaseLease(order);
        continue;
      }
      if (this.inFlight.has(order.id)) {
        await this.safeReleaseLease(order);
        continue;
      }
      if (this.freeSlots() <= 0) {
        await this.safeReleaseLease(order);
        continue;
      }
      this.startProcessing(order);
    }
  }

  private async safeReleaseLease(order: PaymentReconcileClaimedOrder): Promise<void> {
    try {
      const released = await this.lease.releaseLease(order.id, order.leaseOwner);
      if (!released) {
        this.logger.warn(
          `Late/excess claim release no-op for ${order.id} (owner ${order.leaseOwner})`,
        );
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(
        `Failed to release lease for ${order.id} (owner ${order.leaseOwner}): ${message}`,
      );
    }
  }

  private startProcessing(order: PaymentReconcileClaimedOrder): void {
    let invalidated = false;
    let settleAbandon!: () => void;
    const abandoned = new Promise<void>((resolve) => {
      settleAbandon = resolve;
    });
    const ctx: PaymentReconcileWorkContext = {
      order,
      get invalidated() {
        return invalidated;
      },
      invalidate: () => {
        if (invalidated) return;
        invalidated = true;
        settleAbandon();
      },
      canApplyTerminal: () => !invalidated,
    };

    const done = this.runWithRenewal(ctx, abandoned);
    this.inFlight.set(order.id, { ctx, done });
    void done.finally(() => {
      this.inFlight.delete(order.id);
      if (!this.shuttingDown && this.active) {
        this.enqueueTick();
      }
    });
  }

  private async runWithRenewal(
    ctx: PaymentReconcileWorkContext,
    abandoned: Promise<void>,
  ): Promise<void> {
    let renewChain: Promise<void> = Promise.resolve();
    let renewTimer: ReturnType<typeof setInterval> | null = null;

    const enqueueRenew = () => {
      renewChain = renewChain
        .then(async () => {
          if (ctx.invalidated) return;
          const ok = await this.lease.renewLease({
            orderId: ctx.order.id,
            leaseOwner: ctx.order.leaseOwner,
            leaseTtlMs: PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
          });
          if (!ok) {
            ctx.invalidate();
          }
        })
        .catch((error: unknown) => {
          ctx.invalidate();
          const message = error instanceof Error ? error.message : 'unknown';
          this.logger.warn(
            `Lease renew failed for ${ctx.order.id}: ${message}`,
          );
        });
    };

    renewTimer = setInterval(() => {
      enqueueRenew();
    }, this.renewMs);
    renewTimer.unref?.();

    try {
      const processor = this.processor;
      if (processor && !ctx.invalidated) {
        await Promise.race([processor(ctx), abandoned]);
      }
    } catch (error: unknown) {
      ctx.invalidate();
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(
        `Reconcile processor error for ${ctx.order.id}: ${message}`,
      );
    } finally {
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      await renewChain;
      await this.safeReleaseLease(ctx.order);
    }
  }

  private beginShutdownAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runShutdownDrain();
    return this.drainPromise;
  }

  private async runShutdownDrain(): Promise<void> {
    // Order: flag first, then stop polling — prevents new ticks from starting work.
    this.shuttingDown = true;
    this.active = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const pending = [...this.inFlight.values()].map((e) => e.done);

    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        sleepMs(this.drainMs),
      ]);
    }

    // Deadline: invalidate so late processors cannot apply terminals.
    if (this.inFlight.size > 0) {
      for (const entry of this.inFlight.values()) {
        entry.ctx.invalidate();
      }
      // Bounded cleanup for renew drain + token release only — not tickChain/claims.
      await Promise.race([
        Promise.allSettled([...this.inFlight.values()].map((e) => e.done)),
        sleepMs(this.cleanupMs),
      ]);
    }

    // Detach tickChain / fill: claimEligibleBatch cannot be cancelled; late
    // completions release leases inside fillSlotsBody without starting work.
    void this.tickChain.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`Detached tickChain after shutdown: ${message}`);
    });
    void this.fillInFlight?.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown';
      this.logger.warn(`Detached fill after shutdown: ${message}`);
    });
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Re-export max claims for worker-facing docs/tests. */
export { PAYMENT_RECONCILE_MAX_CLAIMS };
