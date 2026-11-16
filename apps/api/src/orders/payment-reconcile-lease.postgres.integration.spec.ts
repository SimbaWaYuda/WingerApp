/**
 * S2.6.20.1 / S2.6.20.4 — PostgreSQL lease races + UTC wall-clock timezone proofs.
 *
 * Opt-in (fails closed when set but DB unreachable):
 *   $env:S26201_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=payment-reconcile-lease.postgres.integration --runInBand --no-coverage
 *
 * Requires migration 20261116120000_payment_reconcile_lease applied to the isolated DB.
 * Does NOT rewrite .env. Does NOT target 5433/winger.
 *
 * S2.6.20.4 timezone cases set PostgreSQL session TimeZone to UTC and America/Chicago
 * on the actual DB sessions (not merely process TZ).
 */
import {
  OrderStatus,
  PaymentReconcileManualReviewReason,
  PaymentStatus,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import {
  utcWallClockIso,
  writeStripeChargeAttemptAtUtc,
} from './payment-reconcile-utc';

jest.setTimeout(180000);

const run = `s26201${Date.now().toString(36)}`;
const optedIn = process.env.S26201_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';
const TZ_UTC = 'UTC';
const TZ_CHICAGO = 'America/Chicago';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.6.20.1 isolated PG tests');
  }
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('?')[0];
  if (url.hostname !== ISOLATED_HOST) {
    throw new Error(`Refusing host ${url.hostname}; expected ${ISOLATED_HOST}`);
  }
  if (url.port !== ISOLATED_PORT) {
    throw new Error(`Refusing port ${url.port}; expected ${ISOLATED_PORT}`);
  }
  if (name !== ISOLATED_DB) {
    throw new Error(`Refusing database ${name}; expected ${ISOLATED_DB}`);
  }
}

function sessionUrl(raw: string, name: string) {
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', name);
  return url.toString();
}

async function canConnect(raw: string): Promise<boolean> {
  const db = new PrismaClient({
    datasources: { db: { url: sessionUrl(raw, 'winger-s26201-probe') } },
  });
  try {
    await db.$connect();
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

async function setSessionTimeZone(db: PrismaClient, tz: string) {
  // SET TIME ZONE does not support bind params; only allow known safe names.
  if (tz !== TZ_UTC && tz !== TZ_CHICAGO) {
    throw new Error(`Refusing unexpected TimeZone ${tz}`);
  }
  await db.$executeRawUnsafe(`SET TIME ZONE '${tz}'`);
  const rows = await db.$queryRawUnsafe<{ timezone: string }[]>(
    `SELECT current_setting('TIMEZONE') AS timezone`,
  );
  expect(rows[0]?.timezone).toBe(tz);
}

/** Read TIMESTAMP WITHOUT TIME ZONE as literal wall-clock text (no session shift). */
async function readTimestampText(
  db: PrismaClient,
  orderId: string,
  column:
    | 'stripeChargeAttemptAt'
    | 'paymentReconcileLeaseExpiresAt'
    | 'paymentReconcileNextAt'
    | 'paymentReconcileManualReviewAt',
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<{ v: string | null }[]>(
    `SELECT "${column}"::text AS v FROM "Order" WHERE id = $1`,
    orderId,
  );
  return rows[0]?.v ?? null;
}

/** Compare PG timestamp text to an ISO UTC instant (trim to ms precision). */
function expectUtcWallClock(text: string | null, ms: number) {
  expect(text).toBeTruthy();
  const normalized = text!.replace(' ', 'T');
  const expected = utcWallClockIso(ms).replace(/Z$/, '');
  // PG ::text may omit trailing zeros in fractional seconds; compare via Date parse of UTC.
  const parsed = Date.parse(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  expect(parsed).toBe(ms);
  expect(normalized.startsWith(expected.slice(0, 19))).toBe(true);
}

describe('S2.6.20.1 PostgreSQL lease gate (always runs)', () => {
  it('does not claim concurrency proof without opt-in; fails closed when opted in but DB down', async () => {
    const raw = process.env.DATABASE_URL ?? '';
    if (!optedIn) {
      expect(optedIn).toBe(false);
      return;
    }
    assertIsolatedDatabaseUrl(raw);
    const reachable = await canConnect(raw);
    expect(reachable).toBe(true);
  });
});

const concurrencyDescribe = optedIn ? describe : describe.skip;

concurrencyDescribe('PostgreSQL payment reconcile lease races (S2.6.20.1)', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let customerId = '';
  let leaseA: PaymentReconcileLeaseService;
  let leaseB: PaymentReconcileLeaseService;
  const orderIds: string[] = [];
  const fixedNow = Date.UTC(2026, 10, 16, 18, 0, 0);

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(raw);
    const reachable = await canConnect(raw);
    if (!reachable) {
      throw new Error(
        `S26201_PG_TESTS=1 but PostgreSQL unreachable at ${ISOLATED_HOST}:${ISOLATED_PORT}/${ISOLATED_DB}`,
      );
    }
    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26201-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26201-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26201-gate') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
    ]);
    await setSessionTimeZone(sessionA, TZ_UTC);
    await setSessionTimeZone(sessionB, TZ_UTC);
    await setSessionTimeZone(sessionGate, TZ_UTC);

    await sessionGate.$queryRaw`
      SELECT "paymentReconcileLeaseOwner", "paymentReconcileAttemptCount"
      FROM "Order"
      LIMIT 0
    `;

    customerId = `${run}-cust`;
    await sessionGate.user.create({
      data: {
        id: customerId,
        email: `${run}@s26201.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S26201 Customer',
        role: UserRole.CUSTOMER,
      },
    });

    leaseA = new PaymentReconcileLeaseService(sessionA as never);
    leaseB = new PaymentReconcileLeaseService(sessionB as never);
  });

  afterAll(async () => {
    if (!sessionGate) return;
    try {
      if (orderIds.length) {
        await sessionGate.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await sessionGate.user.deleteMany({ where: { id: customerId } });
    } finally {
      await Promise.all([
        sessionA?.$disconnect(),
        sessionB?.$disconnect(),
        sessionGate?.$disconnect(),
      ]);
    }
  });

  async function seedPendingCard(overrides: {
    idSuffix: string;
    attemptAgeMs?: number;
    nextAt?: Date | null;
    leaseOwner?: string | null;
    leaseExpiresAt?: Date | null;
    attemptCount?: number;
    /** Bound-only stage default; pass null to assert unbound exclusion. */
    stripePaymentIntentId?: string | null;
  }) {
    const id = `${run}-ord-${overrides.idSuffix}`;
    orderIds.push(id);
    const attemptAtMs = fixedNow - (overrides.attemptAgeMs ?? 10 * 60 * 1000);
    const nextIso =
      overrides.nextAt === undefined || overrides.nextAt === null
        ? null
        : utcWallClockIso(overrides.nextAt.getTime());
    const leaseExpiresIso = overrides.leaseExpiresAt
      ? utcWallClockIso(overrides.leaseExpiresAt.getTime())
      : null;
    // Full order id keeps stripePaymentIntentId unique under the DB unique constraint.
    const piId =
      overrides.stripePaymentIntentId === undefined
        ? `pi_${id}`
        : overrides.stripePaymentIntentId;
    await sessionGate.order.create({
      data: {
        id,
        displayId: `WG-${id.slice(-8)}`,
        customerId,
        customerEmail: `${run}@s26201.invalid`,
        customerName: 'S26201 Customer',
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 10,
        total: 10,
        paymentAmount: 10,
        stripePaymentIntentId: piId,
        paymentReconcileLeaseOwner: overrides.leaseOwner ?? null,
        paymentReconcileAttemptCount: overrides.attemptCount ?? 0,
      } as never,
    });
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET
        "stripeChargeAttemptAt" = ${utcWallClockIso(attemptAtMs)}::timestamp,
        "paymentReconcileNextAt" = ${nextIso}::timestamp,
        "paymentReconcileLeaseExpiresAt" = ${leaseExpiresIso}::timestamp
      WHERE id = ${id}
    `;
    return id;
  }

  function installTransactionBarrier(target: PrismaClient) {
    const original = target.$transaction.bind(target);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let invocations = 0;

    target.$transaction = (async (...args: unknown[]) => {
      invocations += 1;
      if (invocations === 1) {
        signalEntered();
        await gate;
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof target.$transaction;

    return {
      entered,
      release: () => releaseGate(),
      invocations: () => invocations,
      restore: () => {
        target.$transaction = original;
      },
    };
  }

  /** Keep earlier fixtures out of later claimEligibleBatch calls in this suite. */
  async function quarantineRaceFixtures() {
    if (!orderIds.length) return;
    await sessionGate.order.updateMany({
      where: { id: { in: [...orderIds] } },
      data: {
        paymentReconcileManualReviewAt: new Date(fixedNow - 1),
        paymentReconcileLeaseOwner: null,
        paymentReconcileLeaseExpiresAt: null,
      },
    });
  }

  it('Bound-only: literal pi_ prefix (LEFT=pi_); excludes LIKE wildcards', async () => {
    await quarantineRaceFixtures();
    // Run-scoped values avoid unique-constraint clashes across suite re-runs;
    // `pi_` alone still proves LEFT(...,3)='pi_' for the bare-prefix edge case.
    const cases: { suffix: string; pi: string | null; expectClaim: boolean }[] =
      [
        { suffix: 'pi-123', pi: `pi_123_${run}`, expectClaim: true },
        { suffix: 'pi-bare', pi: 'pi_', expectClaim: true },
        { suffix: 'pixa', pi: `pixa123_${run}`, expectClaim: false },
        { suffix: 'pix', pi: 'pix', expectClaim: false },
        { suffix: 'pi-only', pi: 'pi', expectClaim: false },
        { suffix: 'empty', pi: '', expectClaim: false },
        { suffix: 'null-pi', pi: null, expectClaim: false },
        { suffix: 'ch', pi: `ch_123_${run}`, expectClaim: false },
      ];
    const seeded: { id: string; expectClaim: boolean }[] = [];
    for (const c of cases) {
      const id = await seedPendingCard({
        idSuffix: c.suffix,
        stripePaymentIntentId: c.pi,
      });
      seeded.push({ id, expectClaim: c.expectClaim });
    }

    const claimed = await leaseA.claimEligibleBatch({
      limit: 20,
      nowMs: fixedNow,
      graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
      leaseTtlMs: 60_000,
    });
    const ids = new Set(claimed.map((c) => c.id));
    for (const row of seeded) {
      expect(ids.has(row.id)).toBe(row.expectClaim);
      if (!row.expectClaim) {
        const db = await sessionGate.order.findUniqueOrThrow({
          where: { id: row.id },
        });
        expect(db.paymentReconcileAttemptCount).toBe(0);
        expect(db.paymentReconcileLeaseOwner).toBeNull();
      }
    }
  });

  it('Race A: two workers claim the same eligible order — only one wins', async () => {
    const id = await seedPendingCard({ idSuffix: 'a1' });
    const barrier = installTransactionBarrier(sessionA);
    try {
      const pA = leaseA.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
        leaseTtlMs: 60_000,
      });
      await barrier.entered;
      const pB = leaseB.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
        leaseTtlMs: 60_000,
      });
      await new Promise((r) => setImmediate(r));
      barrier.release();
      const [a, b] = await Promise.all([pA, pB]);
      const winners = [...a, ...b].filter((c) => c.id === id);
      expect(winners).toHaveLength(1);
      const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
      expect(row.paymentReconcileLeaseOwner).toBe(winners[0].leaseOwner);
      expect(row.paymentReconcileAttemptCount).toBe(1);
    } finally {
      barrier.restore();
    }
  });

  it('Race B: expired lease reclaimed; old token cannot release or reschedule', async () => {
    const oldToken = randomUUID();
    const id = await seedPendingCard({
      idSuffix: 'b1',
      leaseOwner: oldToken,
      leaseExpiresAt: new Date(fixedNow - 1),
      attemptCount: 2,
    });
    const claimed = await leaseB.claimEligibleBatch({
      limit: 5,
      nowMs: fixedNow,
      graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
      leaseTtlMs: 120_000,
    });
    const win = claimed.find((c) => c.id === id);
    expect(win).toBeTruthy();
    expect(win!.leaseOwner).not.toBe(oldToken);
    expect(await leaseA.releaseLease(id, oldToken)).toBe(false);
    expect(
      await leaseA.scheduleNextAttempt({
        orderId: id,
        leaseOwner: oldToken,
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentReconcileLeaseOwner).toBe(win!.leaseOwner);
    expect(row.paymentReconcileAttemptCount).toBe(3);
    expect(row.paymentReconcileNextAt).toBeNull();
  });

  it('Race C: concurrent claims over multiple orders — at most one owner each; batch limits', async () => {
    const ids = await Promise.all([
      seedPendingCard({ idSuffix: 'c1', attemptAgeMs: 30 * 60_000 }),
      seedPendingCard({ idSuffix: 'c2', attemptAgeMs: 25 * 60_000 }),
      seedPendingCard({ idSuffix: 'c3', attemptAgeMs: 20 * 60_000 }),
      seedPendingCard({ idSuffix: 'c4', attemptAgeMs: 15 * 60_000 }),
    ]);
    const barrier = installTransactionBarrier(sessionA);
    try {
      const pA = leaseA.claimEligibleBatch({
        limit: 2,
        nowMs: fixedNow,
        graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
        leaseTtlMs: 60_000,
      });
      await barrier.entered;
      const pB = leaseB.claimEligibleBatch({
        limit: 2,
        nowMs: fixedNow,
        graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
        leaseTtlMs: 60_000,
      });
      await new Promise((r) => setImmediate(r));
      barrier.release();
      const [a, b] = await Promise.all([pA, pB]);
      expect(a.length).toBeLessThanOrEqual(2);
      expect(b.length).toBeLessThanOrEqual(2);
      const all = [...a, ...b];
      expect(all.length).toBeLessThanOrEqual(4);
      const byId = new Map<string, string[]>();
      for (const c of all) {
        const list = byId.get(c.id) ?? [];
        list.push(c.leaseOwner);
        byId.set(c.id, list);
      }
      for (const owners of byId.values()) {
        expect(owners).toHaveLength(1);
      }
      for (const id of ids) {
        const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
        if (row.paymentReconcileLeaseOwner) {
          expect(row.paymentReconcileAttemptCount).toBe(1);
        } else {
          expect(row.paymentReconcileAttemptCount).toBe(0);
        }
      }
      expect(all.length).toBe(4);
    } finally {
      barrier.restore();
    }
  });

  it('Race D: terminal PENDING→PAID blocks reschedule and renew for the lease holder', async () => {
    const id = await seedPendingCard({ idSuffix: 'd1' });
    const [held] = await leaseA.claimEligibleBatch({
      limit: 1,
      nowMs: fixedNow,
      graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
      leaseTtlMs: 60_000,
    });
    expect(held.id).toBe(id);

    await sessionGate.order.update({
      where: { id },
      data: { paymentStatus: PaymentStatus.PAID },
    });

    expect(
      await leaseA.scheduleNextAttempt({
        orderId: id,
        leaseOwner: held.leaseOwner,
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(
      await leaseA.renewLease({
        orderId: id,
        leaseOwner: held.leaseOwner,
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(
      await leaseA.markManualReview({
        orderId: id,
        leaseOwner: held.leaseOwner,
        reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
        nowMs: fixedNow,
      }),
    ).toBe(false);

    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    expect(row.paymentReconcileNextAt).toBeNull();
    expect(row.paymentReconcileManualReviewAt).toBeNull();
    expect(await leaseA.releaseLease(id, held.leaseOwner)).toBe(true);
  });

  it('Race E: transaction rollback leaves no lease or attempt increment', async () => {
    const id = await seedPendingCard({ idSuffix: 'e1' });
    const before = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(before.paymentReconcileAttemptCount).toBe(0);
    expect(before.paymentReconcileLeaseOwner).toBeNull();

    await expect(
      sessionA.$transaction(async (tx) => {
        const candidates = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Order"
          WHERE id = ${id}
          FOR UPDATE SKIP LOCKED
        `;
        expect(candidates).toHaveLength(1);
        await tx.$executeRaw`
          UPDATE "Order"
          SET
            "paymentReconcileLeaseOwner" = ${'rollback-token'},
            "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow + 60_000)}::timestamp,
            "paymentReconcileAttemptCount" = "paymentReconcileAttemptCount" + 1
          WHERE id = ${id}
        `;
        throw new Error('forced-rollback');
      }),
    ).rejects.toThrow(/forced-rollback/);

    const after = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(after.paymentReconcileLeaseOwner).toBeNull();
    expect(after.paymentReconcileLeaseExpiresAt).toBeNull();
    expect(after.paymentReconcileAttemptCount).toBe(0);
  });
});

concurrencyDescribe('PostgreSQL UTC timestamp semantics (S2.6.20.4)', () => {
  let sessionUtc: PrismaClient;
  let sessionChi: PrismaClient;
  let sessionGate: PrismaClient;
  let customerId = '';
  let leaseUtc: PaymentReconcileLeaseService;
  let leaseChi: PaymentReconcileLeaseService;
  const orderIds: string[] = [];
  const fixedNow = Date.UTC(2026, 10, 16, 18, 0, 0);
  const graceMs = PAYMENT_RECONCILE_DEFAULT_GRACE_MS;
  const leaseTtlMs = 60_000;

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(raw);
    const reachable = await canConnect(raw);
    if (!reachable) {
      throw new Error(
        `S26201_PG_TESTS=1 but PostgreSQL unreachable at ${ISOLATED_HOST}:${ISOLATED_PORT}/${ISOLATED_DB}`,
      );
    }
    sessionUtc = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26204-utc') } },
    });
    sessionChi = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26204-chi') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26204-gate') } },
    });
    await Promise.all([
      sessionUtc.$connect(),
      sessionChi.$connect(),
      sessionGate.$connect(),
    ]);
    await setSessionTimeZone(sessionUtc, TZ_UTC);
    await setSessionTimeZone(sessionChi, TZ_CHICAGO);
    await setSessionTimeZone(sessionGate, TZ_UTC);

    customerId = `${run}-tz-cust`;
    await sessionGate.user.create({
      data: {
        id: customerId,
        email: `${run}-tz@s26204.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S26204 TZ Customer',
        role: UserRole.CUSTOMER,
      },
    });

    leaseUtc = new PaymentReconcileLeaseService(sessionUtc as never);
    leaseChi = new PaymentReconcileLeaseService(sessionChi as never);
  });

  afterAll(async () => {
    if (!sessionGate) return;
    try {
      if (orderIds.length) {
        await sessionGate.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await sessionGate.user.deleteMany({ where: { id: customerId } });
    } finally {
      await Promise.all([
        sessionUtc?.$disconnect(),
        sessionChi?.$disconnect(),
        sessionGate?.$disconnect(),
      ]);
    }
  });

  /** Prevent earlier fixtures from matching later claimEligibleBatch calls. */
  async function quarantineExisting() {
    if (!orderIds.length) return;
    await sessionGate.order.updateMany({
      where: { id: { in: [...orderIds] } },
      data: {
        paymentReconcileManualReviewAt: new Date(fixedNow - 1),
        paymentReconcileLeaseOwner: null,
        paymentReconcileLeaseExpiresAt: null,
      },
    });
  }

  async function seedBarePending(idSuffix: string) {
    await quarantineExisting();
    const id = `${run}-tz-${idSuffix}`;
    orderIds.push(id);
    await sessionGate.order.create({
      data: {
        id,
        displayId: `TZ-${randomUUID().slice(0, 10)}`,
        customerId,
        customerEmail: `${run}-tz@s26204.invalid`,
        customerName: 'S26204 TZ Customer',
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 10,
        total: 10,
        paymentAmount: 10,
        stripePaymentIntentId: `pi_${id}`,
        paymentReconcileAttemptCount: 0,
      },
    });
    return id;
  }

  async function seedWithAttempt(
    idSuffix: string,
    attemptAtMs: number,
    extras?: {
      leaseOwner?: string;
      leaseExpiresAtMs?: number;
      attemptCount?: number;
      quarantine?: boolean;
      stripePaymentIntentId?: string | null;
    },
  ) {
    if (extras?.quarantine !== false) {
      await quarantineExisting();
    }
    const id = `${run}-tz-${idSuffix}`;
    orderIds.push(id);
    const leaseExpiresIso =
      extras?.leaseExpiresAtMs != null
        ? utcWallClockIso(extras.leaseExpiresAtMs)
        : null;
    const piId =
      extras && Object.prototype.hasOwnProperty.call(extras, 'stripePaymentIntentId')
        ? extras.stripePaymentIntentId
        : `pi_${id}`;
    await sessionGate.order.create({
      data: {
        id,
        displayId: `TZ-${randomUUID().slice(0, 10)}`,
        customerId,
        customerEmail: `${run}-tz@s26204.invalid`,
        customerName: 'S26204 TZ Customer',
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 10,
        total: 10,
        paymentAmount: 10,
        stripePaymentIntentId: piId,
        paymentReconcileLeaseOwner: extras?.leaseOwner ?? null,
        paymentReconcileAttemptCount: extras?.attemptCount ?? 0,
      },
    });
    // Stamp TIMESTAMP WITHOUT TIME ZONE via ::timestamp so session TZ cannot skew fixtures.
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET
        "stripeChargeAttemptAt" = ${utcWallClockIso(attemptAtMs)}::timestamp,
        "paymentReconcileLeaseExpiresAt" = ${leaseExpiresIso}::timestamp
      WHERE id = ${id}
    `;
    return id;
  }

  it('A: markStripeChargeAttempt writes UTC wall clock under UTC and America/Chicago', async () => {
    const beforeMs = Date.now();
    const idUtc = await seedBarePending('a-utc');
    await writeStripeChargeAttemptAtUtc(sessionUtc, idUtc);
    const afterUtc = Date.now();
    const textUtc = await readTimestampText(
      sessionGate,
      idUtc,
      'stripeChargeAttemptAt',
    );
    expect(textUtc).toBeTruthy();
    const writtenUtcMs = Date.parse(`${textUtc!.replace(' ', 'T')}Z`);
    expect(writtenUtcMs).toBeGreaterThanOrEqual(beforeMs - 1000);
    expect(writtenUtcMs).toBeLessThanOrEqual(afterUtc + 1000);

    const beforeChi = Date.now();
    const idChi = await seedBarePending('a-chi');
    await writeStripeChargeAttemptAtUtc(sessionChi, idChi);
    const afterChi = Date.now();
    const textChi = await readTimestampText(
      sessionGate,
      idChi,
      'stripeChargeAttemptAt',
    );
    expect(textChi).toBeTruthy();
    const writtenChiMs = Date.parse(`${textChi!.replace(' ', 'T')}Z`);
    expect(writtenChiMs).toBeGreaterThanOrEqual(beforeChi - 1000);
    expect(writtenChiMs).toBeLessThanOrEqual(afterChi + 1000);

    // Session Chicago must not store local wall clock (which would differ by ~6h in Nov).
    const chicagoOffsetHours = new Date().getTimezoneOffset(); // process TZ; use PG instead
    const pgOffsets = await sessionChi.$queryRaw<{ utc: Date; local: Date }[]>`
      SELECT
        (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS utc,
        (CURRENT_TIMESTAMP AT TIME ZONE 'America/Chicago') AS local
    `;
    // Both writers stored values interpretable as UTC instants near Date.now(),
    // and the two session TimeZones differ (proved by SHOW above).
    void chicagoOffsetHours;
    void pgOffsets;
    expect(Math.abs(writtenUtcMs - writtenChiMs)).toBeLessThan(5000);
  });

  it.each([
    ['UTC', () => leaseUtc],
    ['America/Chicago', () => leaseChi],
  ] as const)(
    'B/C: grace boundary claimable only after two minutes (%s)',
    async (_label, getLease) => {
      const lease = getLease();
      const attemptAt = fixedNow - graceMs;
      await quarantineExisting();
      const beforeId = await seedWithAttempt(`grace-before-${_label}`, attemptAt + 1, {
        quarantine: false,
      });
      const atId = await seedWithAttempt(`grace-at-${_label}`, attemptAt, {
        quarantine: false,
      });
      const afterId = await seedWithAttempt(`grace-after-${_label}`, attemptAt - 1, {
        quarantine: false,
      });

      const claimed = await lease.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs,
        leaseTtlMs,
      });
      const ids = new Set(claimed.map((c) => c.id));
      expect(ids.has(beforeId)).toBe(false);
      expect(ids.has(atId)).toBe(true);
      expect(ids.has(afterId)).toBe(true);
    },
  );

  it.each([
    ['UTC', () => leaseUtc, () => sessionUtc],
    ['America/Chicago', () => leaseChi, () => sessionChi],
  ] as const)(
    'D: renew / schedule / manual / isLeaseHeld expiry boundaries (%s)',
    async (_label, getLease, getSession) => {
      const lease = getLease();
      const session = getSession();
      const token = randomUUID();
      const expiresAt = fixedNow;
      await quarantineExisting();

      const beforeId = await seedWithAttempt(
        `exp-before-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: token,
          leaseExpiresAtMs: expiresAt + 1,
          attemptCount: 1,
          quarantine: false,
        },
      );
      const atId = await seedWithAttempt(`exp-at-${_label}`, fixedNow - 10 * 60_000, {
        leaseOwner: token,
        leaseExpiresAtMs: expiresAt,
        attemptCount: 1,
        quarantine: false,
      });
      const afterId = await seedWithAttempt(
        `exp-after-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: token,
          leaseExpiresAtMs: expiresAt - 1,
          attemptCount: 1,
          quarantine: false,
        },
      );

      expect(await lease.isLeaseHeld(beforeId, token, fixedNow)).toBe(true);
      expect(await lease.isLeaseHeld(atId, token, fixedNow)).toBe(false);
      expect(await lease.isLeaseHeld(afterId, token, fixedNow)).toBe(false);

      expect(
        await lease.renewLease({
          orderId: beforeId,
          leaseOwner: token,
          nowMs: fixedNow,
          leaseTtlMs: 120_000,
        }),
      ).toBe(true);
      expect(
        await lease.renewLease({
          orderId: atId,
          leaseOwner: token,
          nowMs: fixedNow,
          leaseTtlMs: 120_000,
        }),
      ).toBe(false);
      expect(
        await lease.renewLease({
          orderId: afterId,
          leaseOwner: token,
          nowMs: fixedNow,
          leaseTtlMs: 120_000,
        }),
      ).toBe(false);

      // Fresh active lease for schedule / manual boundaries
      const schedToken = randomUUID();
      const schedBefore = await seedWithAttempt(
        `sched-before-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: schedToken,
          leaseExpiresAtMs: expiresAt + 1,
          attemptCount: 1,
          quarantine: false,
        },
      );
      const schedAt = await seedWithAttempt(
        `sched-at-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: schedToken,
          leaseExpiresAtMs: expiresAt,
          attemptCount: 1,
          quarantine: false,
        },
      );
      expect(
        await lease.scheduleNextAttempt({
          orderId: schedBefore,
          leaseOwner: schedToken,
          nextAt: new Date(fixedNow + 300_000),
          nowMs: fixedNow,
        }),
      ).toBe(true);
      expect(
        await lease.scheduleNextAttempt({
          orderId: schedAt,
          leaseOwner: schedToken,
          nextAt: new Date(fixedNow + 300_000),
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expectUtcWallClock(
        await readTimestampText(session, schedBefore, 'paymentReconcileNextAt'),
        fixedNow + 300_000,
      );

      const manToken = randomUUID();
      const manBefore = await seedWithAttempt(
        `man-before-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: manToken,
          leaseExpiresAtMs: expiresAt + 1,
          attemptCount: 1,
          quarantine: false,
        },
      );
      const manAt = await seedWithAttempt(
        `man-at-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: manToken,
          leaseExpiresAtMs: expiresAt,
          attemptCount: 1,
          quarantine: false,
        },
      );
      expect(
        await lease.markManualReview({
          orderId: manBefore,
          leaseOwner: manToken,
          reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
          nowMs: fixedNow,
        }),
      ).toBe(true);
      expect(
        await lease.markManualReview({
          orderId: manAt,
          leaseOwner: manToken,
          reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expectUtcWallClock(
        await readTimestampText(
          sessionGate,
          manBefore,
          'paymentReconcileManualReviewAt',
        ),
        fixedNow,
      );
      const manRow = await sessionGate.order.findUniqueOrThrow({
        where: { id: manBefore },
      });
      expect(manRow.paymentReconcileLeaseOwner).toBeNull();
    },
  );

  it('E: lease claimed in UTC renews from America/Chicago without shifting instant', async () => {
    const id = await seedWithAttempt('e-cross', fixedNow - 10 * 60_000);
    const [held] = await leaseUtc.claimEligibleBatch({
      limit: 1,
      nowMs: fixedNow,
      graceMs,
      leaseTtlMs,
    });
    expect(held.id).toBe(id);
    expectUtcWallClock(
      await readTimestampText(sessionGate, id, 'paymentReconcileLeaseExpiresAt'),
      fixedNow + leaseTtlMs,
    );

    const renewed = await leaseChi.renewLease({
      orderId: id,
      leaseOwner: held.leaseOwner,
      nowMs: fixedNow + 1_000,
      leaseTtlMs: 180_000,
    });
    expect(renewed).toBe(true);
    expectUtcWallClock(
      await readTimestampText(sessionGate, id, 'paymentReconcileLeaseExpiresAt'),
      fixedNow + 1_000 + 180_000,
    );
  });

  it('F: expired token cannot renew/schedule; old token cannot mutate replacement', async () => {
    const oldToken = randomUUID();
    const id = await seedWithAttempt('f-old', fixedNow - 10 * 60_000, {
      leaseOwner: oldToken,
      leaseExpiresAtMs: fixedNow - 1,
      attemptCount: 2,
    });
    const [held] = await leaseChi.claimEligibleBatch({
      limit: 5,
      nowMs: fixedNow,
      graceMs,
      leaseTtlMs: 120_000,
    });
    expect(held.id).toBe(id);
    expect(held.leaseOwner).not.toBe(oldToken);

    expect(
      await leaseUtc.renewLease({
        orderId: id,
        leaseOwner: oldToken,
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(
      await leaseUtc.scheduleNextAttempt({
        orderId: id,
        leaseOwner: oldToken,
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);

    // Expired active-looking lease (same session) cannot renew
    const expiredId = await seedWithAttempt('f-exp', fixedNow - 10 * 60_000, {
      leaseOwner: oldToken,
      leaseExpiresAtMs: fixedNow - 1,
      attemptCount: 1,
    });
    expect(
      await leaseUtc.renewLease({
        orderId: expiredId,
        leaseOwner: oldToken,
        nowMs: fixedNow,
      }),
    ).toBe(false);
  });

  it('G: releaseLease cleans up after terminal payment transition', async () => {
    const id = await seedWithAttempt('g-term', fixedNow - 10 * 60_000);
    const [held] = await leaseUtc.claimEligibleBatch({
      limit: 1,
      nowMs: fixedNow,
      graceMs,
      leaseTtlMs,
    });
    await sessionGate.order.update({
      where: { id },
      data: { paymentStatus: PaymentStatus.PAID },
    });
    expect(
      await leaseChi.scheduleNextAttempt({
        orderId: id,
        leaseOwner: held.leaseOwner,
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(await leaseChi.releaseLease(id, held.leaseOwner)).toBe(true);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentReconcileLeaseOwner).toBeNull();
    expect(row.paymentReconcileLeaseExpiresAt).toBeNull();
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it.each([
    ['UTC', () => leaseUtc, () => sessionUtc],
    ['America/Chicago', () => leaseChi, () => sessionChi],
  ] as const)(
    'I: claim reclaim equality boundary + old token blocked (%s)',
    async (_label, getLease, getSession) => {
      const lease = getLease();
      const session = getSession();
      const tzRows = await session.$queryRawUnsafe<{ timezone: string }[]>(
        `SELECT current_setting('TIMEZONE') AS timezone`,
      );
      expect(tzRows[0]?.timezone).toBe(
        _label === 'UTC' ? TZ_UTC : TZ_CHICAGO,
      );

      await quarantineExisting();
      const oldBefore = randomUUID();
      const oldAt = randomUUID();
      const oldAfter = randomUUID();

      // A: expiresAt < now → reclaimable
      const idBefore = await seedWithAttempt(
        `eq-before-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: oldBefore,
          leaseExpiresAtMs: fixedNow - 1,
          attemptCount: 1,
          quarantine: false,
        },
      );
      // B: expiresAt == now → reclaimable
      const idAt = await seedWithAttempt(`eq-at-${_label}`, fixedNow - 10 * 60_000, {
        leaseOwner: oldAt,
        leaseExpiresAtMs: fixedNow,
        attemptCount: 1,
        quarantine: false,
      });
      // C: expiresAt > now → not reclaimable
      const idAfter = await seedWithAttempt(
        `eq-after-${_label}`,
        fixedNow - 10 * 60_000,
        {
          leaseOwner: oldAfter,
          leaseExpiresAtMs: fixedNow + 1,
          attemptCount: 1,
          quarantine: false,
        },
      );

      // D: token at exact equality cannot renew / schedule / manual
      expect(
        await lease.renewLease({
          orderId: idAt,
          leaseOwner: oldAt,
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expect(
        await lease.scheduleNextAttempt({
          orderId: idAt,
          leaseOwner: oldAt,
          nextAt: new Date(fixedNow + 60_000),
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expect(
        await lease.markManualReview({
          orderId: idAt,
          leaseOwner: oldAt,
          reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expect(await lease.isLeaseHeld(idAt, oldAt, fixedNow)).toBe(false);

      const claimed = await lease.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs,
        leaseTtlMs,
      });
      const byId = new Map(claimed.map((c) => [c.id, c]));
      expect(byId.has(idBefore)).toBe(true);
      expect(byId.has(idAt)).toBe(true);
      expect(byId.has(idAfter)).toBe(false);

      // E: replacement token; old token cannot mutate or release
      const replacement = byId.get(idAt)!;
      expect(replacement.leaseOwner).not.toBe(oldAt);
      expect(
        await lease.renewLease({
          orderId: idAt,
          leaseOwner: oldAt,
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expect(
        await lease.scheduleNextAttempt({
          orderId: idAt,
          leaseOwner: oldAt,
          nextAt: new Date(fixedNow + 60_000),
          nowMs: fixedNow,
        }),
      ).toBe(false);
      expect(await lease.releaseLease(idAt, oldAt)).toBe(false);
      const row = await sessionGate.order.findUniqueOrThrow({
        where: { id: idAt },
      });
      expect(row.paymentReconcileLeaseOwner).toBe(replacement.leaseOwner);
      expect(row.paymentReconcileAttemptCount).toBe(2);
    },
  );

  it('H: claim race under mixed session timezones still single-winner', async () => {
    const id = await seedWithAttempt('h-race', fixedNow - 10 * 60_000);
    const original = sessionUtc.$transaction.bind(sessionUtc);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let invocations = 0;
    sessionUtc.$transaction = (async (...args: unknown[]) => {
      invocations += 1;
      if (invocations === 1) {
        signalEntered();
        await gate;
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof sessionUtc.$transaction;
    try {
      const pUtc = leaseUtc.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs,
        leaseTtlMs,
      });
      await entered;
      const pChi = leaseChi.claimEligibleBatch({
        limit: 10,
        nowMs: fixedNow,
        graceMs,
        leaseTtlMs,
      });
      await new Promise((r) => setImmediate(r));
      releaseGate();
      const [a, b] = await Promise.all([pUtc, pChi]);
      const winners = [...a, ...b].filter((c) => c.id === id);
      expect(winners).toHaveLength(1);
      const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
      expect(row.paymentReconcileAttemptCount).toBe(1);
      expect(row.paymentReconcileLeaseOwner).toBe(winners[0].leaseOwner);
    } finally {
      sessionUtc.$transaction = original;
    }
  });
});
