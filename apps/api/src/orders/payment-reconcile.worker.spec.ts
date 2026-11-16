import {
  PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
  PaymentReconcileClaimedOrder,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import { StripeService } from './stripe.service';
import {
  isPaymentReconcileWorkerEnabled,
  paymentReconcileBackoffMs,
  PAYMENT_RECONCILE_WORKER_CONCURRENCY,
  PAYMENT_RECONCILE_WORKER_ENV,
  PaymentReconcileWorker,
  PaymentReconcileWorkContext,
} from './payment-reconcile.worker';

const TEST_RENEW_MS = 1_000;
const TEST_DRAIN_MS = 5_000;
const TEST_CLEANUP_MS = 500;

function claimed(
  overrides: Partial<PaymentReconcileClaimedOrder> = {},
): PaymentReconcileClaimedOrder {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  return {
    id: 'ord-1',
    leaseOwner: 'lease-a',
    leaseExpiresAt: new Date(now + PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS),
    attemptCount: 1,
    paymentMode: 'test',
    stripePaymentIntentId: null,
    stripeChargeAttemptAt: new Date(now - 10 * 60_000),
    paymentReconcileNextAt: null,
    ...overrides,
  };
}

describe('paymentReconcileBackoffMs', () => {
  it('matches approved backoff table', () => {
    expect(paymentReconcileBackoffMs(1)).toBe(2 * 60_000);
    expect(paymentReconcileBackoffMs(2)).toBe(4 * 60_000);
    expect(paymentReconcileBackoffMs(3)).toBe(8 * 60_000);
    expect(paymentReconcileBackoffMs(8)).toBe(256 * 60_000);
    expect(paymentReconcileBackoffMs(20)).toBe(6 * 60 * 60_000);
  });
});

describe('isPaymentReconcileWorkerEnabled', () => {
  it('is disabled by default', () => {
    expect(isPaymentReconcileWorkerEnabled({})).toBe(false);
  });

  it('enables only for exact value 1', () => {
    expect(
      isPaymentReconcileWorkerEnabled({ [PAYMENT_RECONCILE_WORKER_ENV]: '1' }),
    ).toBe(true);
    expect(
      isPaymentReconcileWorkerEnabled({ [PAYMENT_RECONCILE_WORKER_ENV]: 'true' }),
    ).toBe(false);
  });
});

describe('PaymentReconcileWorker', () => {
  let lease: {
    claimEligibleBatch: jest.Mock;
    renewLease: jest.Mock;
    releaseLease: jest.Mock;
  };
  let stripe: { configured: boolean };
  let worker: PaymentReconcileWorker;
  let previousEnv: string | undefined;

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    previousEnv = process.env[PAYMENT_RECONCILE_WORKER_ENV];
    delete process.env[PAYMENT_RECONCILE_WORKER_ENV];
    jest.useFakeTimers();
    lease = {
      claimEligibleBatch: jest.fn().mockResolvedValue([]),
      renewLease: jest.fn().mockResolvedValue(true),
      releaseLease: jest.fn().mockResolvedValue(true),
    };
    stripe = { configured: true };
    worker = new PaymentReconcileWorker(
      lease as unknown as PaymentReconcileLeaseService,
      stripe as unknown as StripeService,
    );
    worker.setTimingForTests({
      renewMs: TEST_RENEW_MS,
      drainMs: TEST_DRAIN_MS,
      cleanupMs: TEST_CLEANUP_MS,
    });
  });

  afterEach(async () => {
    const shutting = worker.shutdownForTests();
    await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS + 100);
    await flush();
    await shutting;
    jest.useRealTimers();
    if (previousEnv === undefined) {
      delete process.env[PAYMENT_RECONCILE_WORKER_ENV];
    } else {
      process.env[PAYMENT_RECONCILE_WORKER_ENV] = previousEnv;
    }
  });

  it('1: remains inactive when env gate is unset', () => {
    worker.onModuleInit();
    expect(worker.isActive).toBe(false);
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
  });

  it('2: activates only when env is exactly 1, Stripe configured, and processor wired', () => {
    process.env[PAYMENT_RECONCILE_WORKER_ENV] = '1';
    worker.setProcessor(async () => undefined);
    worker.onModuleInit();
    expect(worker.isActive).toBe(true);
  });

  it('3: demo/unconfigured Stripe → inactive, zero claims', () => {
    process.env[PAYMENT_RECONCILE_WORKER_ENV] = '1';
    worker.setProcessor(async () => undefined);
    stripe.configured = false;
    worker.onModuleInit();
    expect(worker.isActive).toBe(false);
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
  });

  it('3b: without processor remains inactive even when env and Stripe are ready', async () => {
    process.env[PAYMENT_RECONCILE_WORKER_ENV] = '1';
    worker.onModuleInit();
    expect(worker.isActive).toBe(false);
    await worker.tickForTests();
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
  });

  it('4: three free slots claim at most three', async () => {
    const rows = [
      claimed({ id: 'a', leaseOwner: 'la' }),
      claimed({ id: 'b', leaseOwner: 'lb' }),
      claimed({ id: 'c', leaseOwner: 'lc' }),
    ];
    lease.claimEligibleBatch.mockImplementation(
      async ({ limit }: { limit: number }) => {
        expect(limit).toBe(PAYMENT_RECONCILE_WORKER_CONCURRENCY);
        return rows.slice(0, limit);
      },
    );
    const started: string[] = [];
    worker.setProcessor(async (ctx) => {
      started.push(ctx.order.id);
      await new Promise<void>(() => undefined);
    });
    await worker.tickForTests();
    await flush();
    expect(started.sort()).toEqual(['a', 'b', 'c']);
    expect(worker.inFlightCount).toBe(3);
  });

  it('5: one free slot claims at most one', async () => {
    const gates = new Map<string, () => void>();
    lease.claimEligibleBatch
      .mockResolvedValueOnce([
        claimed({ id: 'a', leaseOwner: 'la' }),
        claimed({ id: 'b', leaseOwner: 'lb' }),
        claimed({ id: 'c', leaseOwner: 'lc' }),
      ])
      .mockImplementation(async ({ limit }: { limit: number }) => {
        expect(limit).toBe(1);
        return [claimed({ id: 'next', leaseOwner: 'ln' })];
      });

    let nextStarted = false;
    worker.setProcessor(async (ctx) => {
      if (ctx.order.id === 'next') {
        nextStarted = true;
        return;
      }
      await new Promise<void>((r) => {
        gates.set(ctx.order.id, r);
      });
    });

    await worker.tickForTests();
    await flush();
    expect(worker.inFlightCount).toBe(3);
    gates.get('a')!();
    await flush();
    await worker.tickForTests();
    await flush();
    expect(nextStarted).toBe(true);
    expect(lease.claimEligibleBatch.mock.calls[1][0].limit).toBe(1);
  });

  it('6: no free slots cause no claim', async () => {
    lease.claimEligibleBatch.mockResolvedValueOnce([
      claimed({ id: 'a', leaseOwner: 'la' }),
      claimed({ id: 'b', leaseOwner: 'lb' }),
      claimed({ id: 'c', leaseOwner: 'lc' }),
    ]);
    worker.setProcessor(async () => {
      await new Promise<void>(() => undefined);
    });
    await worker.tickForTests();
    await flush();
    expect(worker.inFlightCount).toBe(3);
    lease.claimEligibleBatch.mockClear();
    await worker.tickForTests();
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
  });

  it('7: no claim after shutdown starts', async () => {
    worker.setProcessor(async () => undefined);
    lease.claimEligibleBatch.mockResolvedValue([claimed()]);
    const shutdown = worker.shutdownForTests();
    await flush();
    await worker.tickForTests();
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS + 100);
    await shutdown;
  });

  it('8: no idle leased queue — processing starts immediately after claim', async () => {
    const order = claimed({ id: 'immediate' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    let sawOrder: string | null = null;
    worker.setProcessor(async (ctx) => {
      sawOrder = ctx.order.id;
    });
    await worker.tickForTests();
    await flush();
    expect(sawOrder).toBe('immediate');
    expect(lease.releaseLease).toHaveBeenCalledWith('immediate', order.leaseOwner);
  });

  it('9: renewal operations are single-flight', async () => {
    const order = claimed({ id: 'renew' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    let renewCalls = 0;
    let renewInFlight = 0;
    let maxOverlap = 0;
    lease.renewLease.mockImplementation(async () => {
      renewCalls += 1;
      renewInFlight += 1;
      maxOverlap = Math.max(maxOverlap, renewInFlight);
      await Promise.resolve();
      await Promise.resolve();
      renewInFlight -= 1;
      return true;
    });

    let releaseProc!: () => void;
    const gate = new Promise<void>((r) => {
      releaseProc = r;
    });
    worker.setProcessor(async () => {
      await gate;
    });

    await worker.tickForTests();
    await flush();
    await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
    await flush();
    await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
    await flush();
    expect(renewCalls).toBeGreaterThanOrEqual(1);
    expect(maxOverlap).toBe(1);
    releaseProc();
    await flush();
  });

  it('10: renewal failure invalidates the processing context', async () => {
    const order = claimed({ id: 'lose' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    lease.renewLease.mockResolvedValue(false);
    let ctxRef: PaymentReconcileWorkContext | null = null;
    let releaseProc!: () => void;
    const gate = new Promise<void>((r) => {
      releaseProc = r;
    });
    worker.setProcessor(async (ctx) => {
      ctxRef = ctx;
      await gate;
    });
    await worker.tickForTests();
    await flush();
    await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
    await flush();
    expect(ctxRef!.invalidated).toBe(true);
    releaseProc();
    await flush();
  });

  it('11: invalidated processing cannot invoke a terminal callback', async () => {
    const order = claimed({ id: 'term' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    lease.renewLease.mockResolvedValue(false);
    const terminal = jest.fn();
    let releaseProc!: () => void;
    const gate = new Promise<void>((r) => {
      releaseProc = r;
    });
    worker.setProcessor(async (ctx) => {
      await gate;
      if (ctx.canApplyTerminal()) {
        terminal();
      }
    });
    await worker.tickForTests();
    await flush();
    await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
    await flush();
    releaseProc();
    await flush();
    expect(terminal).not.toHaveBeenCalled();
  });

  it('12: shutdown stops polling and claims', async () => {
    process.env[PAYMENT_RECONCILE_WORKER_ENV] = '1';
    worker.setProcessor(async () => undefined);
    worker.onModuleInit();
    await worker.shutdownForTests();
    expect(worker.isActive).toBe(false);
    expect(worker.isShuttingDown).toBe(true);
    lease.claimEligibleBatch.mockClear();
    await worker.tickForTests();
    expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
  });

  it('13: shutdown continues renewal while draining', async () => {
    const order = claimed({ id: 'drain-renew' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    let releaseProc!: () => void;
    const gate = new Promise<void>((r) => {
      releaseProc = r;
    });
    worker.setProcessor(async () => {
      await gate;
    });
    await worker.tickForTests();
    await flush();
    const shutdownPromise = worker.shutdownForTests();
    lease.renewLease.mockClear();
    await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
    await flush();
    expect(lease.renewLease).toHaveBeenCalled();
    releaseProc();
    await flush();
    await shutdownPromise;
  });

  it('14: drain deadline invalidates remaining work', async () => {
    const order = claimed({ id: 'deadline' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    let ctxRef: PaymentReconcileWorkContext | null = null;
    worker.setProcessor(async (ctx) => {
      ctxRef = ctx;
      await new Promise<void>(() => undefined);
    });
    await worker.tickForTests();
    await flush();
    const shutdownPromise = worker.shutdownForTests();
    await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS);
    await flush();
    expect(ctxRef!.invalidated).toBe(true);
    await jest.advanceTimersByTimeAsync(TEST_CLEANUP_MS);
    await shutdownPromise;
  });

  it('15: token-gated release uses the claim lease owner', async () => {
    const order = claimed({ id: 'rel', leaseOwner: 'token-xyz' });
    lease.claimEligibleBatch.mockResolvedValue([order]);
    worker.setProcessor(async () => undefined);
    await worker.tickForTests();
    await flush();
    expect(lease.releaseLease).toHaveBeenCalledWith('rel', 'token-xyz');
  });

  describe('S2.6.20.8b lifecycle hardening', () => {
    it('1: shutdown deadline with hung claim does not await indefinitely', async () => {
      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      const hungClaim = new Promise<PaymentReconcileClaimedOrder[]>((r) => {
        releaseClaim = r;
      });
      lease.claimEligibleBatch.mockReturnValue(hungClaim);
      worker.setProcessor(async () => undefined);

      const tickPromise = worker.tickForTests();
      await flush();
      expect(worker.isFillInFlight).toBe(true);

      const shutdownPromise = worker.shutdownForTests();
      let shutdownDone = false;
      void shutdownPromise.then(() => {
        shutdownDone = true;
      });

      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS + 50);
      await flush();
      expect(shutdownDone).toBe(true);
      await shutdownPromise;

      // Late claim must release, not process.
      const late = claimed({ id: 'late-hung', leaseOwner: 'late-token' });
      releaseClaim([late]);
      await flush();
      await tickPromise;
      expect(lease.releaseLease).toHaveBeenCalledWith('late-hung', 'late-token');
      expect(worker.inFlightCount).toBe(0);
    });

    it('2/3: late claim after shutdown — no processing; token release', async () => {
      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockReturnValue(
        new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          releaseClaim = r;
        }),
      );
      let processed = 0;
      worker.setProcessor(async () => {
        processed += 1;
      });

      const tickPromise = worker.tickForTests();
      await flush();
      const shutdownPromise = worker.shutdownForTests();
      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS);
      await shutdownPromise;

      releaseClaim([claimed({ id: 'late', leaseOwner: 'tok-late' })]);
      await flush();
      await tickPromise;
      expect(processed).toBe(0);
      expect(lease.releaseLease).toHaveBeenCalledWith('late', 'tok-late');
    });

    it('4: late claim release failure does not produce unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockReturnValue(
        new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          releaseClaim = r;
        }),
      );
      lease.releaseLease.mockRejectedValue(new Error('db down'));
      worker.setProcessor(async () => undefined);

      const tickPromise = worker.tickForTests();
      await flush();
      const shutdownPromise = worker.shutdownForTests();
      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS);
      await shutdownPromise;

      releaseClaim([claimed({ id: 'fail-rel', leaseOwner: 't1' })]);
      await flush();
      await tickPromise;
      await flush();

      process.off('unhandledRejection', onUnhandled);
      expect(unhandled).toEqual([]);
    });

    it('5: shutdown does not await tickChain indefinitely', async () => {
      process.env[PAYMENT_RECONCILE_WORKER_ENV] = '1';
      worker.setProcessor(async () => undefined);
      worker.onModuleInit();

      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockReturnValue(
        new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          releaseClaim = r;
        }),
      );
      // Kick a hung fill via poll tick chain
      await jest.advanceTimersByTimeAsync(30_000);
      await flush();

      const shutdownPromise = worker.shutdownForTests();
      let done = false;
      void shutdownPromise.then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS + 50);
      await flush();
      expect(done).toBe(true);
      await shutdownPromise;
      releaseClaim([]);
      await flush();
    });

    it('6: active processing continues renewal during drain', async () => {
      const order = claimed({ id: 'drain-renew-2' });
      lease.claimEligibleBatch.mockResolvedValue([order]);
      let releaseProc!: () => void;
      const gate = new Promise<void>((r) => {
        releaseProc = r;
      });
      worker.setProcessor(async () => {
        await gate;
      });
      await worker.tickForTests();
      await flush();
      const shutdownPromise = worker.shutdownForTests();
      lease.renewLease.mockClear();
      await jest.advanceTimersByTimeAsync(TEST_RENEW_MS);
      await flush();
      expect(lease.renewLease).toHaveBeenCalled();
      releaseProc();
      await flush();
      await jest.advanceTimersByTimeAsync(TEST_CLEANUP_MS);
      await shutdownPromise;
    });

    it('7/8: drain deadline invalidates; late terminal blocked', async () => {
      const order = claimed({ id: 'term-deadline' });
      lease.claimEligibleBatch.mockResolvedValue([order]);
      const terminal = jest.fn();
      let releaseProc!: () => void;
      const gate = new Promise<void>((r) => {
        releaseProc = r;
      });
      worker.setProcessor(async (ctx) => {
        await gate;
        if (ctx.canApplyTerminal()) terminal();
      });
      await worker.tickForTests();
      await flush();
      const shutdownPromise = worker.shutdownForTests();
      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS);
      await flush();
      releaseProc();
      await flush();
      await jest.advanceTimersByTimeAsync(TEST_CLEANUP_MS);
      await shutdownPromise;
      expect(terminal).not.toHaveBeenCalled();
    });

    it('9: concurrent fillSlots share one guard', async () => {
      let claimStarts = 0;
      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockImplementation(() => {
        claimStarts += 1;
        return new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          releaseClaim = r;
        });
      });
      worker.setProcessor(async () => undefined);

      const a = worker.tickForTests();
      const b = worker.tickForTests();
      await flush();
      expect(claimStarts).toBe(1);
      releaseClaim([]);
      await Promise.all([a, b]);
      expect(claimStarts).toBe(1);
    });

    it('10: concurrent fills cannot exceed concurrency three', async () => {
      lease.claimEligibleBatch.mockImplementation(
        async ({ limit }: { limit: number }) => {
          expect(limit).toBeLessThanOrEqual(3);
          return Array.from({ length: limit }, (_, i) =>
            claimed({ id: `x${i}-${limit}`, leaseOwner: `lx${i}-${limit}` }),
          );
        },
      );
      worker.setProcessor(async () => {
        await new Promise<void>(() => undefined);
      });
      await Promise.all([
        worker.tickForTests(),
        worker.tickForTests(),
        worker.tickForTests(),
      ]);
      await flush();
      expect(worker.inFlightCount).toBeLessThanOrEqual(3);
    });

    it('11: failed claim releases the fill guard', async () => {
      lease.claimEligibleBatch
        .mockRejectedValueOnce(new Error('claim boom'))
        .mockResolvedValueOnce([]);
      worker.setProcessor(async () => undefined);
      await worker.tickForTests();
      await flush();
      expect(worker.isFillInFlight).toBe(false);
      await worker.tickForTests();
      expect(lease.claimEligibleBatch).toHaveBeenCalledTimes(2);
    });

    it('12: completion refill cannot overlap an active fill', async () => {
      let claimStarts = 0;
      let holdClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockImplementation(() => {
        claimStarts += 1;
        if (claimStarts === 1) {
          return Promise.resolve([claimed({ id: 'fast', leaseOwner: 'lf' })]);
        }
        return new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          holdClaim = r;
        });
      });

      let releaseFast!: () => void;
      worker.setProcessor(async (ctx) => {
        if (ctx.order.id === 'fast') {
          await new Promise<void>((r) => {
            releaseFast = r;
          });
        }
      });

      await worker.tickForTests();
      await flush();
      // Start a long fill, then complete fast work (would enqueue refill).
      const longFill = worker.tickForTests();
      await flush();
      expect(claimStarts).toBe(2);
      releaseFast!();
      await flush();
      // Coalesced refill waited on longFill — no third claim yet.
      expect(claimStarts).toBe(2);
      holdClaim([]);
      await longFill;
      await flush();
    });

    it('13: shutdown prevents queued fills from starting', async () => {
      let releaseClaim!: (rows: PaymentReconcileClaimedOrder[]) => void;
      lease.claimEligibleBatch.mockReturnValue(
        new Promise<PaymentReconcileClaimedOrder[]>((r) => {
          releaseClaim = r;
        }),
      );
      worker.setProcessor(async () => undefined);

      const first = worker.tickForTests();
      await flush();
      const second = worker.tickForTests(); // coalesced onto first
      await worker.shutdownForTests();
      await jest.advanceTimersByTimeAsync(TEST_DRAIN_MS + TEST_CLEANUP_MS);
      releaseClaim([claimed({ id: 'after-sd', leaseOwner: 'asd' })]);
      await first;
      await second;
      await flush();
      // After first fill completes under shutdown, second already awaited same fill;
      // a new tickForTests must not claim.
      lease.claimEligibleBatch.mockClear();
      await worker.tickForTests();
      expect(lease.claimEligibleBatch).not.toHaveBeenCalled();
      expect(lease.releaseLease).toHaveBeenCalledWith('after-sd', 'asd');
    });
  });
});
