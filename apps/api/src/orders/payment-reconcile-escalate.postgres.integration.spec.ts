/**
 * S2.6.20.5a — PostgreSQL unleaseable-order escalation concurrency.
 *
 * Opt-in (fails closed when set but DB unreachable):
 *   $env:S26205_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=payment-reconcile-escalate.postgres.integration --runInBand --no-coverage
 *
 * Requires migrations through 20261116153000_payment_reconcile_manual_review_reason on the isolated DB.
 * Does NOT rewrite .env. Does NOT target 5433/winger.
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
  PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS,
  PaymentReconcileEscalateService,
} from './payment-reconcile-escalate.service';
import { utcWallClockIso } from './payment-reconcile-utc';

jest.setTimeout(180000);

const run = `s26205${Date.now().toString(36)}`;
const optedIn = process.env.S26205_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';
const TZ_UTC = 'UTC';
const TZ_CHICAGO = 'America/Chicago';
const ageMs = PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS;

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.6.20.5a isolated PG tests');
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
    datasources: { db: { url: sessionUrl(raw, 'winger-s26205-probe') } },
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
  if (tz !== TZ_UTC && tz !== TZ_CHICAGO) {
    throw new Error(`Refusing unexpected TimeZone ${tz}`);
  }
  await db.$executeRawUnsafe(`SET TIME ZONE '${tz}'`);
  const rows = await db.$queryRawUnsafe<{ timezone: string }[]>(
    `SELECT current_setting('TIMEZONE') AS timezone`,
  );
  expect(rows[0]?.timezone).toBe(tz);
}

describe('S2.6.20.5a PostgreSQL escalate gate (always runs)', () => {
  it('does not claim concurrency proof without opt-in; fails closed when opted in but DB down', async () => {
    const raw = process.env.DATABASE_URL ?? '';
    if (!optedIn) {
      expect(optedIn).toBe(false);
      return;
    }
    assertIsolatedDatabaseUrl(raw);
    expect(await canConnect(raw)).toBe(true);
  });
});

const concurrencyDescribe = optedIn ? describe : describe.skip;

concurrencyDescribe('PostgreSQL unleaseable escalation (S2.6.20.5a)', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let escalateA: PaymentReconcileEscalateService;
  let escalateB: PaymentReconcileEscalateService;
  let customerId = '';
  const orderIds: string[] = [];
  const fixedNow = Date.UTC(2026, 10, 16, 18, 0, 0);

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(raw);
    if (!(await canConnect(raw))) {
      throw new Error(
        `S26205_PG_TESTS=1 but PostgreSQL unreachable at ${ISOLATED_HOST}:${ISOLATED_PORT}/${ISOLATED_DB}`,
      );
    }
    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26205-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26205-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26205-gate') } },
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
      SELECT "paymentReconcileManualReviewReason"
      FROM "Order"
      LIMIT 0
    `;

    customerId = `${run}-cust`;
    await sessionGate.user.create({
      data: {
        id: customerId,
        email: `${run}@s26205.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S26205 Customer',
        role: UserRole.CUSTOMER,
      },
    });

    escalateA = new PaymentReconcileEscalateService(sessionA as never);
    escalateB = new PaymentReconcileEscalateService(sessionB as never);
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

  async function quarantineExisting() {
    if (!orderIds.length) return;
    await sessionGate.order.updateMany({
      where: { id: { in: [...orderIds] } },
      data: {
        paymentReconcileManualReviewAt: new Date(fixedNow - 1),
        paymentReconcileManualReviewReason:
          PaymentReconcileManualReviewReason.SEARCH_UNRESOLVED,
      },
    });
  }

  async function seedOrder(opts: {
    idSuffix: string;
    createdAtMs: number;
    attemptAtMs?: number | null;
    leaseOwner?: string | null;
    leaseExpiresAtMs?: number | null;
    manualReviewReason?: PaymentReconcileManualReviewReason | null;
    paymentMode?: string;
    quarantine?: boolean;
  }) {
    if (opts.quarantine !== false) await quarantineExisting();
    const id = `${run}-ord-${opts.idSuffix}-${randomUUID().slice(0, 8)}`;
    orderIds.push(id);
    await sessionGate.order.create({
      data: {
        id,
        displayId: `E5-${randomUUID().slice(0, 10)}`,
        customerId,
        customerEmail: `${run}@s26205.invalid`,
        customerName: 'S26205 Customer',
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: opts.paymentMode ?? 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 10,
        total: 10,
        paymentAmount: 10,
        paymentReconcileLeaseOwner: opts.leaseOwner ?? null,
        paymentReconcileAttemptCount: 0,
        paymentReconcileManualReviewReason: opts.manualReviewReason ?? null,
      },
    });
    const attemptIso =
      opts.attemptAtMs === undefined
        ? null
        : opts.attemptAtMs === null
          ? null
          : utcWallClockIso(opts.attemptAtMs);
    const leaseExpiresIso =
      opts.leaseExpiresAtMs == null
        ? null
        : utcWallClockIso(opts.leaseExpiresAtMs);
    const reviewAtIso = opts.manualReviewReason
      ? utcWallClockIso(fixedNow - 60_000)
      : null;
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET
        "createdAt" = ${utcWallClockIso(opts.createdAtMs)}::timestamp,
        "updatedAt" = ${utcWallClockIso(opts.createdAtMs)}::timestamp,
        "stripeChargeAttemptAt" = ${attemptIso}::timestamp,
        "paymentReconcileLeaseExpiresAt" = ${leaseExpiresIso}::timestamp,
        "paymentReconcileManualReviewAt" = ${reviewAtIso}::timestamp
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
      restore: () => {
        target.$transaction = original;
      },
    };
  }

  it('1: two scanners race — only one escalation wins', async () => {
    const id = await seedOrder({
      idSuffix: 'race',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
    });
    const barrier = installTransactionBarrier(sessionA);
    try {
      const pA = escalateA.escalateUnleaseableOrders({
        batchSize: 10,
        nowMs: fixedNow,
        ageMs,
      });
      await barrier.entered;
      const pB = escalateB.escalateUnleaseableOrders({
        batchSize: 10,
        nowMs: fixedNow,
        ageMs,
      });
      await new Promise((r) => setImmediate(r));
      barrier.release();
      const [a, b] = await Promise.all([pA, pB]);
      const wins = [...a.orderIds, ...b.orderIds].filter((x) => x === id);
      expect(wins).toHaveLength(1);
      expect(a.escalated + b.escalated).toBeGreaterThanOrEqual(1);
      const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
      expect(row.paymentReconcileManualReviewReason).toBe(
        PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
      );
    } finally {
      barrier.restore();
    }
  });

  it('2/3: missing → MISSING_ATTEMPT_AT; future → INCONSISTENT_ATTEMPT_AT', async () => {
    await quarantineExisting();
    const miss = await seedOrder({
      idSuffix: 'miss',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
      quarantine: false,
    });
    const fut = await seedOrder({
      idSuffix: 'fut',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: fixedNow + 60_000,
      quarantine: false,
    });
    const result = await escalateA.escalateUnleaseableOrders({
      batchSize: 10,
      nowMs: fixedNow,
      ageMs,
    });
    expect(result.orderIds).toEqual(expect.arrayContaining([miss, fut]));
    expect(result.byReason.MISSING_ATTEMPT_AT).toBeGreaterThanOrEqual(1);
    expect(result.byReason.INCONSISTENT_ATTEMPT_AT).toBeGreaterThanOrEqual(1);
    expect(
      (
        await sessionGate.order.findUniqueOrThrow({ where: { id: miss } })
      ).paymentReconcileManualReviewReason,
    ).toBe(PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT);
    expect(
      (
        await sessionGate.order.findUniqueOrThrow({ where: { id: fut } })
      ).paymentReconcileManualReviewReason,
    ).toBe(PaymentReconcileManualReviewReason.INCONSISTENT_ATTEMPT_AT);
  });

  it('4/5: active lease untouched; expired lease escalated', async () => {
    await quarantineExisting();
    const active = await seedOrder({
      idSuffix: 'active',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
      leaseOwner: randomUUID(),
      leaseExpiresAtMs: fixedNow + 60_000,
      quarantine: false,
    });
    const expired = await seedOrder({
      idSuffix: 'expired',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
      leaseOwner: randomUUID(),
      leaseExpiresAtMs: fixedNow - 1,
      quarantine: false,
    });
    const result = await escalateA.escalateUnleaseableOrders({
      batchSize: 10,
      nowMs: fixedNow,
      ageMs,
    });
    expect(result.orderIds).not.toContain(active);
    expect(result.orderIds).toContain(expired);
    const activeRow = await sessionGate.order.findUniqueOrThrow({
      where: { id: active },
    });
    expect(activeRow.paymentReconcileManualReviewAt).toBeNull();
    expect(activeRow.paymentReconcileLeaseOwner).toBeTruthy();
    const expiredRow = await sessionGate.order.findUniqueOrThrow({
      where: { id: expired },
    });
    expect(expiredRow.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
    );
    expect(expiredRow.paymentReconcileLeaseOwner).toBeNull();
  });

  it('6: existing manual review cannot be overwritten', async () => {
    const id = await seedOrder({
      idSuffix: 'exists',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
      manualReviewReason: PaymentReconcileManualReviewReason.SEARCH_AMBIGUOUS,
    });
    const result = await escalateA.escalateUnleaseableOrders({
      batchSize: 10,
      nowMs: fixedNow,
      ageMs,
    });
    expect(result.orderIds).not.toContain(id);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.SEARCH_AMBIGUOUS,
    );
  });

  it('7: exact 30-minute createdAt boundary', async () => {
    await quarantineExisting();
    const at = await seedOrder({
      idSuffix: 'bound-at',
      createdAtMs: fixedNow - ageMs,
      attemptAtMs: null,
      quarantine: false,
    });
    const young = await seedOrder({
      idSuffix: 'bound-young',
      createdAtMs: fixedNow - ageMs + 1,
      attemptAtMs: null,
      quarantine: false,
    });
    const result = await escalateA.escalateUnleaseableOrders({
      batchSize: 10,
      nowMs: fixedNow,
      ageMs,
    });
    expect(result.orderIds).toContain(at);
    expect(result.orderIds).not.toContain(young);
  });

  it.each([
    ['UTC', TZ_UTC],
    ['America/Chicago', TZ_CHICAGO],
  ] as const)(
    '8: session TimeZone %s yields consistent escalation',
    async (_label, tz) => {
      await setSessionTimeZone(sessionA, tz);
      const tzRows = await sessionA.$queryRawUnsafe<{ timezone: string }[]>(
        `SELECT current_setting('TIMEZONE') AS timezone`,
      );
      expect(tzRows[0]?.timezone).toBe(tz);

      const id = await seedOrder({
        idSuffix: `tz-${_label}`,
        createdAtMs: fixedNow - ageMs - 5_000,
        attemptAtMs: null,
      });
      const result = await escalateA.escalateUnleaseableOrders({
        batchSize: 5,
        nowMs: fixedNow,
        ageMs,
      });
      expect(result.orderIds).toContain(id);
      const text = await sessionGate.$queryRawUnsafe<{ v: string | null }[]>(
        `SELECT "paymentReconcileManualReviewAt"::text AS v FROM "Order" WHERE id = $1`,
        id,
      );
      const parsed = Date.parse(
        `${text[0]!.v!.replace(' ', 'T')}Z`,
      );
      expect(parsed).toBe(fixedNow);
      await setSessionTimeZone(sessionA, TZ_UTC);
    },
  );

  it('9: escalated PENDING can still be marked PAID via existing claim path', async () => {
    const id = await seedOrder({
      idSuffix: 'paid',
      createdAtMs: fixedNow - ageMs - 1,
      attemptAtMs: null,
    });
    const escalated = await escalateA.escalateUnleaseableOrders({
      batchSize: 5,
      nowMs: fixedNow,
      ageMs,
    });
    expect(escalated.orderIds).toContain(id);

    // Mirrors claimPaidOrder predicate: PENDING → PAID without manualReview gate.
    const claimed = await sessionGate.order.updateMany({
      where: { id, paymentStatus: PaymentStatus.PENDING },
      data: {
        paymentStatus: PaymentStatus.PAID,
        stripePaymentIntentId: `pi_${randomUUID().slice(0, 12)}`,
      },
    });
    expect(claimed.count).toBe(1);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    expect(row.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
    );
  });
});
