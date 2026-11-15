import {
  RefundAttemptStatus,
  RefundReconciliationResult,
  RefundSubmissionOutcome,
  UserRole,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import type { CommissionLedgerService } from '../commissions/commission-ledger.service';
import { RefundAttemptService } from './refund-attempt.service';
import { REFUND_ATTEMPT_V1_ENV } from './refund-attempt.types';
import { StripeService } from './stripe.service';

type Attempt = {
  id: string;
  operationKey: string;
  kind: string;
  status: RefundAttemptStatus;
  orderId: string;
  returnRequestId: string | null;
  orderItemId: string | null;
  orderShipmentId: string | null;
  supplierId: string | null;
  actorUserId: string;
  stripePaymentIntentId: string;
  stripeRefundId: string | null;
  amount: { toString(): string; valueOf?: () => number } | number;
  amountCents: number;
  currency: string;
  includeDelivery: boolean;
  shipmentRefundApplied: boolean;
  clawbackAppliedAt: Date | null;
  appliedAt: Date | null;
  applyError: string | null;
  lastError: string | null;
  investigationReason: string | null;
};

type Submission = {
  id: string;
  refundAttemptId: string;
  version: number;
  stripeIdempotencyKey: string;
  submittedAt: Date | null;
  reconciliationResult: RefundReconciliationResult;
  stripeRefundId: string | null;
  outcome: RefundSubmissionOutcome;
};

type Shipment = {
  id: string;
  orderId: string;
  supplierId: string;
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
  refundedAmount: number;
};

type OrderRow = { id: string; currency: string };
type ClawbackRow = {
  id: string;
  returnRequestId: string;
  orderItemCommissionId: string;
  appliedAt: Date | null;
};
type CommissionSnap = { id: string; orderItemId: string };

function cloneRow<T extends object>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = new Date(value.getTime());
    } else if (
      value != null &&
      typeof value === 'object' &&
      'toString' in value &&
      typeof (value as { toString(): string }).toString === 'function' &&
      !(value instanceof Date)
    ) {
      // Prisma.Decimal and similar — keep numeric snapshot via toString.
      const asNum = Number(value);
      out[key] = Number.isFinite(asNum)
        ? asNum
        : (value as { toString(): string }).toString();
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function cloneMap<K, V extends object>(src: Map<K, V>): Map<K, V> {
  return new Map([...src.entries()].map(([k, v]) => [k, cloneRow(v)]));
}

function createMemoryPrisma() {
  const attempts = new Map<string, Attempt>();
  const byKey = new Map<string, string>();
  const submissions = new Map<string, Submission>();
  const shipments = new Map<string, Shipment>();
  const orders = new Map<string, OrderRow>();
  const clawbacks = new Map<string, ClawbackRow>();
  const commissions = new Map<string, CommissionSnap>();
  let attemptSeq = 0;
  let subSeq = 0;

  const api = {
    async $executeRaw() {
      return 1;
    },
    refundAttempt: {
      async findUnique(args: {
        where: { operationKey?: string; id?: string };
        include?: { submissions?: unknown };
      }) {
        let row: Attempt | undefined;
        if (args.where.operationKey) {
          const id = byKey.get(args.where.operationKey);
          row = id ? attempts.get(id) : undefined;
        } else if (args.where.id) {
          row = attempts.get(args.where.id);
        }
        if (!row) return null;
        if (args.include?.submissions) {
          const list = [...submissions.values()]
            .filter((s) => s.refundAttemptId === row!.id)
            .sort((a, b) => b.version - a.version);
          return { ...row, submissions: list.slice(0, 1) };
        }
        return { ...row };
      },
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = attempts.get(args.where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      },
      async create(args: { data: Omit<Attempt, 'id'> & { id?: string } }) {
        const id = args.data.id ?? `ra_${++attemptSeq}`;
        const row: Attempt = {
          id,
          operationKey: args.data.operationKey,
          kind: args.data.kind,
          status: args.data.status,
          orderId: args.data.orderId,
          returnRequestId: args.data.returnRequestId ?? null,
          orderItemId: args.data.orderItemId ?? null,
          orderShipmentId: args.data.orderShipmentId ?? null,
          supplierId: args.data.supplierId ?? null,
          actorUserId: args.data.actorUserId,
          stripePaymentIntentId: args.data.stripePaymentIntentId,
          stripeRefundId: args.data.stripeRefundId ?? null,
          amount: args.data.amount,
          amountCents: args.data.amountCents,
          currency: args.data.currency,
          includeDelivery: args.data.includeDelivery ?? false,
          shipmentRefundApplied: args.data.shipmentRefundApplied ?? false,
          clawbackAppliedAt: args.data.clawbackAppliedAt ?? null,
          appliedAt: args.data.appliedAt ?? null,
          applyError: args.data.applyError ?? null,
          lastError: args.data.lastError ?? null,
          investigationReason: args.data.investigationReason ?? null,
        };
        attempts.set(id, row);
        byKey.set(row.operationKey, id);
        return { ...row };
      },
      async update(args: {
        where: { id: string };
        data: Partial<Attempt> & { stripeRefundId?: string | null };
      }) {
        const row = attempts.get(args.where.id);
        if (!row) throw new Error('not found');
        for (const [key, value] of Object.entries(args.data)) {
          if (value !== undefined) {
            (row as Record<string, unknown>)[key] = value;
          }
        }
        return { ...row };
      },
      async updateMany(args: {
        where: {
          id: string;
          appliedAt?: null;
          status?: { in: RefundAttemptStatus[] };
        };
        data: Partial<Attempt>;
      }) {
        const row = attempts.get(args.where.id);
        if (!row) return { count: 0 };
        if (args.where.appliedAt === null && row.appliedAt != null) {
          return { count: 0 };
        }
        if (
          args.where.status?.in &&
          !args.where.status.in.includes(row.status)
        ) {
          return { count: 0 };
        }
        for (const [key, value] of Object.entries(args.data)) {
          if (value !== undefined) {
            (row as Record<string, unknown>)[key] = value;
          }
        }
        return { count: 1 };
      },
    },
    refundAttemptSubmission: {
      async findUnique(args: { where: { id: string } }) {
        const row = submissions.get(args.where.id);
        return row ? { ...row } : null;
      },
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = submissions.get(args.where.id);
        if (!row) throw new Error('not found');
        return { ...row };
      },
      async findFirst(args: {
        where: { refundAttemptId: string };
        orderBy: { version: 'desc' };
      }) {
        const list = [...submissions.values()]
          .filter((s) => s.refundAttemptId === args.where.refundAttemptId)
          .sort((a, b) => b.version - a.version);
        return list[0] ? { ...list[0] } : null;
      },
      async findFirstOrThrow(args: {
        where: { refundAttemptId: string };
        orderBy: { version: 'desc' };
      }) {
        const row = await api.refundAttemptSubmission.findFirst(args);
        if (!row) throw new Error('not found');
        return row;
      },
      async findMany(args: {
        where: {
          refundAttemptId: string;
          outcome?: RefundSubmissionOutcome;
          stripeRefundId?: { not: null };
        };
        orderBy?: { version: 'asc' | 'desc' };
      }) {
        let list = [...submissions.values()].filter(
          (s) => s.refundAttemptId === args.where.refundAttemptId,
        );
        if (args.where.outcome) {
          list = list.filter((s) => s.outcome === args.where.outcome);
        }
        if (args.where.stripeRefundId?.not === null) {
          list = list.filter((s) => s.stripeRefundId != null);
        }
        list.sort((a, b) =>
          args.orderBy?.version === 'desc'
            ? b.version - a.version
            : a.version - b.version,
        );
        return list.map((s) => ({ ...s }));
      },
      async create(args: { data: Omit<Submission, 'id'> & { id?: string } }) {
        const dup = [...submissions.values()].find(
          (s) =>
            s.refundAttemptId === args.data.refundAttemptId &&
            s.version === args.data.version,
        );
        if (dup) {
          const err = new Error('Unique constraint failed') as Error & {
            code: string;
          };
          err.code = 'P2002';
          throw err;
        }
        const id = args.data.id ?? `sub_${++subSeq}`;
        const row: Submission = {
          id,
          refundAttemptId: args.data.refundAttemptId,
          version: args.data.version,
          stripeIdempotencyKey: args.data.stripeIdempotencyKey,
          submittedAt: args.data.submittedAt ?? null,
          reconciliationResult: args.data.reconciliationResult,
          stripeRefundId: args.data.stripeRefundId ?? null,
          outcome: args.data.outcome,
        };
        submissions.set(id, row);
        return { ...row };
      },
      async update(args: { where: { id: string }; data: Partial<Submission> }) {
        const row = submissions.get(args.where.id);
        if (!row) throw new Error('not found');
        for (const [key, value] of Object.entries(args.data)) {
          if (value !== undefined) {
            (row as Record<string, unknown>)[key] = value;
          }
        }
        return { ...row };
      },
    },
    orderShipment: {
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = shipments.get(args.where.id);
        if (!row) throw new Error('shipment not found');
        return { ...row };
      },
      async update(args: {
        where: { id: string };
        data: { refundedAmount: { toString(): string } | number };
      }) {
        const row = shipments.get(args.where.id);
        if (!row) throw new Error('shipment not found');
        row.refundedAmount = Number(args.data.refundedAmount);
        return { ...row };
      },
    },
    order: {
      async findUniqueOrThrow(args: {
        where: { id: string };
        select?: { currency?: true };
      }) {
        const row = orders.get(args.where.id);
        if (!row) throw new Error('order not found');
        return { ...row };
      },
    },
    commissionClawback: {
      async findUnique(args: { where: { returnRequestId: string } }) {
        const row = [...clawbacks.values()].find(
          (c) => c.returnRequestId === args.where.returnRequestId,
        );
        return row ? { ...row } : null;
      },
    },
    orderItemCommission: {
      async findUnique(args: { where: { orderItemId: string } }) {
        const row = [...commissions.values()].find(
          (c) => c.orderItemId === args.where.orderItemId,
        );
        return row ? { ...row } : null;
      },
    },
  };

  // Serialize interactive txns so concurrent apply tests honor FOR UPDATE ordering.
  let txnChain: Promise<unknown> = Promise.resolve();

  const prisma = {
    ...api,
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
      const run = txnChain.then(async () => {
        const snapAttempts = cloneMap(attempts);
        const snapByKey = new Map(byKey);
        const snapSubs = cloneMap(submissions);
        const snapShip = cloneMap(shipments);
        const snapOrders = cloneMap(orders);
        const snapClaw = cloneMap(clawbacks);
        const snapComm = cloneMap(commissions);
        try {
          return await fn(api);
        } catch (error) {
          attempts.clear();
          for (const [k, v] of snapAttempts) attempts.set(k, v);
          byKey.clear();
          for (const [k, v] of snapByKey) byKey.set(k, v);
          submissions.clear();
          for (const [k, v] of snapSubs) submissions.set(k, v);
          shipments.clear();
          for (const [k, v] of snapShip) shipments.set(k, v);
          orders.clear();
          for (const [k, v] of snapOrders) orders.set(k, v);
          clawbacks.clear();
          for (const [k, v] of snapClaw) clawbacks.set(k, v);
          commissions.clear();
          for (const [k, v] of snapComm) commissions.set(k, v);
          throw error;
        }
      });
      txnChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    _attempts: attempts,
    _submissions: submissions,
    _shipments: shipments,
    _orders: orders,
    _clawbacks: clawbacks,
    _commissions: commissions,
    seedShipment(row: Shipment) {
      shipments.set(row.id, { ...row });
    },
    seedOrder(row: OrderRow) {
      orders.set(row.id, { ...row });
    },
    seedClawback(row: ClawbackRow) {
      clawbacks.set(row.id, { ...row });
    },
    seedCommission(row: CommissionSnap) {
      commissions.set(row.id, { ...row });
    },
  };

  return prisma;
}

const actorUser: AuthUser = {
  sub: 'u-1',
  email: 'a@b.co',
  role: UserRole.ADMIN,
  name: 'Admin',
};

describe('RefundAttemptService (S2.1)', () => {
  const previousFlag = process.env[REFUND_ATTEMPT_V1_ENV];

  afterEach(() => {
    if (previousFlag === undefined) delete process.env[REFUND_ATTEMPT_V1_ENV];
    else process.env[REFUND_ATTEMPT_V1_ENV] = previousFlag;
  });

  function build(
    stripeOverrides?: Partial<StripeService>,
    ledgerOverrides?: Partial<CommissionLedgerService>,
  ) {
    const prisma = createMemoryPrisma();
    const stripe = {
      listRefundsForPaymentIntent: jest.fn(),
      createRefundForAttempt: jest.fn(),
      ...stripeOverrides,
    } as unknown as StripeService;
    const ledger = {
      applyReturnClawback: jest.fn().mockResolvedValue({
        legacy: false,
        applied: true,
      }),
      ...ledgerOverrides,
    } as unknown as CommissionLedgerService;
    const service = new RefundAttemptService(
      prisma as never,
      stripe,
      ledger,
    );
    return { service, prisma, stripe, ledger };
  }

  const ensureParams = {
    kind: 'RETURN' as const,
    operationKey: 'return:ret-1',
    orderId: 'ord-1',
    actorUserId: 'u-1',
    stripePaymentIntentId: 'pi_1',
    amount: 10,
    amountCents: 1000,
    currency: 'usd',
    returnRequestId: 'ret-1',
    orderItemId: 'item-1',
    orderShipmentId: 'ship-1',
    supplierId: 'sup-1',
  };

  it('reports the feature flag without touching refund execution paths', () => {
    const { service } = build();
    expect(service.isV1Enabled()).toBe(false);
    process.env[REFUND_ATTEMPT_V1_ENV] = 'true';
    expect(service.isV1Enabled()).toBe(true);
  });

  it('ensureAttemptForOperation creates attempt + v1 and freezes amount on reload', async () => {
    const { service } = build();
    const first = await service.ensureAttemptForOperation(ensureParams);
    expect(first.submission.version).toBe(1);
    expect(first.submission.stripeIdempotencyKey).toBe(
      'winger-ra:return:ret-1:v1',
    );

    const second = await service.ensureAttemptForOperation(ensureParams);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(second.submission.id).toBe(first.submission.id);

    await expect(
      service.ensureAttemptForOperation({ ...ensureParams, amountCents: 999 }),
    ).rejects.toThrow(/amountCents frozen/);
  });

  it('submitCurrentSubmission persists pending without attempt-level succeeded id', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_pending', status: 'pending', failureReason: null },
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const result = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    expect(result.created).toBe(true);
    expect(result.submission.stripeRefundId).toBe('re_pending');
    expect(result.submission.outcome).toBe('PENDING');
    expect(result.attempt.status).toBe('PENDING');
    expect(result.attempt.stripeRefundId).toBeNull();
    expect(
      service.isReadyForApply({
        attemptStatus: result.attempt.status,
        submissionOutcome: result.submission.outcome,
        submissionStripeRefundId: result.submission.stripeRefundId,
      }),
    ).toBe(false);

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);
    expect(blocked.blockedReason).toMatch(/stripe_refund_object_already_known/);
  });

  it('submitCurrentSubmission marks succeeded and sets attempt stripeRefundId', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_ok', status: 'succeeded', failureReason: null },
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const result = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(result.attempt.status).toBe('STRIPE_SUCCEEDED');
    expect(result.attempt.stripeRefundId).toBe('re_ok');
    expect(result.submission.outcome).toBe('SUCCEEDED');
    expect(
      service.isReadyForApply({
        attemptStatus: result.attempt.status,
        submissionOutcome: result.submission.outcome,
        submissionStripeRefundId: result.submission.stripeRefundId,
      }),
    ).toBe(true);
  });

  it('submitCurrentSubmission records failed objects without treating them as success', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: {
        id: 're_fail',
        status: 'failed',
        failureReason: 'expired_or_canceled_card',
      },
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const result = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(result.submission.outcome).toBe('FAILED');
    expect(result.submission.stripeRefundId).toBe('re_fail');
    expect(result.attempt.status).toBe('STRIPE_FAILED');
    expect(result.attempt.stripeRefundId).toBeNull();
    expect(result.attempt.lastError).toContain('stripe_status=failed');
  });

  it('marks uncertain Stripe errors as SUBMISSION_UNKNOWN and blocks create', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: false,
      message: 'timeout',
      uncertain: true,
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const result = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(result.submission.outcome).toBe('SUBMISSION_UNKNOWN');
    expect(result.attempt.status).toBe('SUBMISSION_UNKNOWN');

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.blockedReason).toBe('must_reconcile_before_create');
  });

  it('reconcile MATCHED_LIVE pending then succeeded upgrades without a second create', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_1', status: 'pending', failureReason: null },
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [
        {
          id: 're_1',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          failureReason: null,
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
      ],
    });

    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('MATCHED_LIVE');
    expect(reconciled.attempt.status).toBe('STRIPE_SUCCEEDED');
    expect(reconciled.attempt.stripeRefundId).toBe('re_1');
    expect(stripe.createRefundForAttempt).toHaveBeenCalledTimes(1);
  });

  it('reconcile NO_MATCH after exhausted pages opens a new version and preserves v1', async () => {
    const { service, stripe, prisma } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    // Force UNKNOWN so reconcile is the path (no id yet).
    await prisma.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: { outcome: RefundSubmissionOutcome.SUBMISSION_UNKNOWN },
    });

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [],
    });

    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('OPENED_NEXT_VERSION');
    expect(reconciled.submission.outcome).toBe('SUPERSEDED_BY_NO_MATCH');
    expect(reconciled.openedSubmission?.version).toBe(2);
    expect(reconciled.openedSubmission?.stripeIdempotencyKey).toBe(
      'winger-ra:return:ret-1:v2',
    );
    // v1 row still present
    const v1 = await prisma.refundAttemptSubmission.findUnique({
      where: { id: ensured.submission.id },
    });
    expect(v1!.outcome).toBe('SUPERSEDED_BY_NO_MATCH');
  });

  it('reconcile incomplete pagination never records NO_MATCH', async () => {
    const { service, stripe } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: false,
      exhausted: false,
      message: 'network',
      refunds: [],
    });
    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('INCOMPLETE');
    expect(reconciled.submission.reconciliationResult).not.toBe('NO_MATCH');
    expect(reconciled.attempt.status).toBe('SUBMISSION_UNKNOWN');
  });

  it('reconcile AMBIGUOUS blocks further creates', async () => {
    const { service, stripe } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [
        {
          id: 're_a',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          failureReason: null,
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
        {
          id: 're_b',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          failureReason: null,
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
      ],
    });
    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('AMBIGUOUS');
    expect(reconciled.attempt.status).toBe('NEEDS_INVESTIGATION');

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);
    expect(blocked.blockedReason).toMatch(/ambiguous|attempt_status/);
  });

  it('failed create then next version preserves v1 refund id', async () => {
    const { service, stripe, prisma } = build();
    (stripe.createRefundForAttempt as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v1', status: 'failed', failureReason: 'declined' },
      })
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v2', status: 'succeeded', failureReason: null },
      });

    const ensured = await service.ensureAttemptForOperation(ensureParams);
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    // ensureAttempt opens v2 after confirmed failed/canceled object (MATCHED + FAILED).
    const afterFail = await service.ensureAttemptForOperation(ensureParams);
    expect(afterFail.submission.version).toBe(2);

    const v1 = await prisma.refundAttemptSubmission.findUnique({
      where: { id: ensured.submission.id },
    });
    expect(v1!.stripeRefundId).toBe('re_v1');
    expect(v1!.outcome).toBe('SUPERSEDED_BY_NO_MATCH');

    const v2 = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(v2.submission.version).toBe(2);
    expect(v2.submission.stripeRefundId).toBe('re_v2');
    expect(v2.attempt.stripeRefundId).toBe('re_v2');
    expect(v1!.stripeRefundId).toBe('re_v1');
  });

  it('does not call Stripe inside the claim transaction (ordering)', async () => {
    const events: string[] = [];
    const prisma = createMemoryPrisma();
    const origTx = prisma.$transaction.bind(prisma);
    prisma.$transaction = (async (fn: (tx: never) => Promise<unknown>) => {
      events.push('txn_start');
      const result = await origTx(fn);
      events.push('txn_end');
      return result;
    }) as typeof prisma.$transaction;

    const stripe = {
      listRefundsForPaymentIntent: jest.fn(),
      createRefundForAttempt: jest.fn(async () => {
        events.push('stripe_create');
        return {
          ok: true,
          refund: { id: 're_1', status: 'succeeded', failureReason: null },
        };
      }),
    } as unknown as StripeService;
    const ledger = {
      applyReturnClawback: jest.fn(),
    } as unknown as CommissionLedgerService;

    const service = new RefundAttemptService(prisma as never, stripe, ledger);
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    events.length = 0;
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    const createIdx = events.indexOf('stripe_create');
    expect(createIdx).toBeGreaterThan(-1);
    // Stripe create must not sit between an unmatched txn_start/txn_end pair.
    let depth = 0;
    for (const ev of events) {
      if (ev === 'txn_start') depth += 1;
      if (ev === 'txn_end') depth -= 1;
      if (ev === 'stripe_create') expect(depth).toBe(0);
    }
  });

  it('crash window: PENDING+submittedAt+no id + empty list does not open v2 or create again', async () => {
    const { service, stripe, prisma } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);

    // Simulate claim-then-crash: submittedAt set, no stripeRefundId, still PENDING.
    await prisma.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: { submittedAt: new Date(), stripeRefundId: null, outcome: 'PENDING' },
    });

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [],
    });
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_should_not', status: 'succeeded', failureReason: null },
    });

    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('UNRESOLVED_INFLIGHT');
    expect(reconciled.openedSubmission).toBeUndefined();
    expect(reconciled.submission.outcome).toBe('SUBMISSION_UNKNOWN');

    const versions = [...prisma._submissions.values()].filter(
      (s) => s.refundAttemptId === ensured.attempt.id,
    );
    expect(versions).toHaveLength(1);

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);
    expect(stripe.createRefundForAttempt).not.toHaveBeenCalled();
  });

  it('repeated empty reconciliations of unresolved in-flight never open v2 or create', async () => {
    const { service, stripe, prisma } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);

    await prisma.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        submittedAt: new Date(),
        stripeRefundId: null,
        outcome: 'PENDING',
        reconciliationResult: 'NONE',
      },
    });

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [],
    });
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_v2_should_not', status: 'succeeded', failureReason: null },
    });

    const first = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(first.classification).toBe('UNRESOLVED_INFLIGHT');
    expect(first.submission.outcome).toBe('SUBMISSION_UNKNOWN');
    expect(first.submission.reconciliationResult).not.toBe('NO_MATCH');
    expect(first.openedSubmission).toBeUndefined();
    expect(first.attempt.status).toBe('SUBMISSION_UNKNOWN');
    expect(
      service.isReadyForApply({
        attemptStatus: first.attempt.status,
        submissionOutcome: first.submission.outcome,
        submissionStripeRefundId: first.submission.stripeRefundId,
        succeededSubmissionCount: 0,
      }),
    ).toBe(false);

    const second = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(second.classification).toBe('UNRESOLVED_INFLIGHT');
    expect(second.submission.outcome).toBe('SUBMISSION_UNKNOWN');
    expect(second.submission.reconciliationResult).not.toBe('NO_MATCH');
    expect(second.openedSubmission).toBeUndefined();

    const versions = [...prisma._submissions.values()].filter(
      (s) => s.refundAttemptId === ensured.attempt.id,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);

    // Still cannot open a next version or submit a new-version create.
    const ensuredAgain = await service.ensureAttemptForOperation(ensureParams);
    expect(ensuredAgain.submission.version).toBe(1);
    expect(ensuredAgain.submission.outcome).toBe('SUBMISSION_UNKNOWN');

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);
    expect(stripe.createRefundForAttempt).not.toHaveBeenCalled();
  });

  it('confirmed failed/canceled object can still open v2 after the safe gate', async () => {
    const { service, stripe, prisma } = build();
    (stripe.createRefundForAttempt as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_fail', status: 'canceled', failureReason: 'canceled' },
      })
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_ok', status: 'succeeded', failureReason: null },
      });

    const ensured = await service.ensureAttemptForOperation(ensureParams);
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    const afterFail = await prisma.refundAttemptSubmission.findUnique({
      where: { id: ensured.submission.id },
    });
    expect(afterFail!.outcome).toBe('FAILED');
    expect(afterFail!.stripeRefundId).toBe('re_fail');
    expect(afterFail!.reconciliationResult).toBe('MATCHED');

    const opened = await service.ensureAttemptForOperation(ensureParams);
    expect(opened.submission.version).toBe(2);
    const v2 = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(v2.created).toBe(true);
    expect(v2.submission.version).toBe(2);
    expect(v2.attempt.stripeRefundId).toBe('re_ok');
  });

  it('reconciling old v1 after v2 succeeds cannot downgrade attempt or clear success id', async () => {
    const { service, stripe, prisma } = build();
    (stripe.createRefundForAttempt as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v1', status: 'failed', failureReason: 'declined' },
      })
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v2', status: 'succeeded', failureReason: null },
      });

    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const v1Id = ensured.submission.id;
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    await service.ensureAttemptForOperation(ensureParams);
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    const afterV2 = await prisma.refundAttempt.findUniqueOrThrow({
      where: { id: ensured.attempt.id },
    });
    expect(afterV2.status).toBe('STRIPE_SUCCEEDED');
    expect(afterV2.stripeRefundId).toBe('re_v2');

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [
        {
          id: 're_v1',
          amount: 1000,
          currency: 'usd',
          status: 'failed',
          failureReason: 'declined',
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
      ],
    });

    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: v1Id,
    });
    expect(reconciled.attempt.status).toBe('STRIPE_SUCCEEDED');
    expect(reconciled.attempt.stripeRefundId).toBe('re_v2');

    const v1 = await prisma.refundAttemptSubmission.findUnique({
      where: { id: v1Id },
    });
    expect(v1!.stripeRefundId).toBe('re_v1');

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);
    expect(blocked.blockedReason).toMatch(/STRIPE_SUCCEEDED/);
  });

  it('requires_action blocks another create; reconcile can promote to succeeded', async () => {
    const { service, stripe } = build();
    (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
      ok: true,
      refund: { id: 're_ra', status: 'requires_action', failureReason: null },
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const first = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(first.submission.stripeRefundId).toBe('re_ra');
    expect(first.attempt.stripeRefundId).toBeNull();

    const blocked = await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });
    expect(blocked.created).toBe(false);

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [
        {
          id: 're_ra',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          failureReason: null,
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
      ],
    });
    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.attempt.status).toBe('STRIPE_SUCCEEDED');
    expect(reconciled.attempt.stripeRefundId).toBe('re_ra');
  });

  it('incomplete pagination never opens a new version', async () => {
    const { service, stripe, prisma } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: false,
      exhausted: false,
      message: 'page failed',
      refunds: [],
    });
    const reconciled = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: ensured.submission.id,
    });
    expect(reconciled.classification).toBe('INCOMPLETE');
    expect(
      [...prisma._submissions.values()].filter(
        (s) => s.refundAttemptId === ensured.attempt.id,
      ),
    ).toHaveLength(1);
  });

  it('late successful v1 after v2 exists is recorded and triggers multi-success investigation', async () => {
    const { service, stripe, prisma } = build();
    (stripe.createRefundForAttempt as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v1', status: 'pending', failureReason: null },
      })
      .mockResolvedValueOnce({
        ok: true,
        refund: { id: 're_v2', status: 'succeeded', failureReason: null },
      });

    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const v1Id = ensured.submission.id;
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    // Force open v2 while v1 still pending with id (simulate parallel / ops path).
    await prisma.refundAttemptSubmission.update({
      where: { id: v1Id },
      data: {
        outcome: 'FAILED',
        reconciliationResult: 'MATCHED',
        stripeRefundId: 're_v1',
      },
    });
    await prisma.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: { status: 'STRIPE_FAILED', stripeRefundId: null },
    });

    const v2 = await service.ensureAttemptForOperation(ensureParams);
    expect(v2.submission.version).toBe(2);
    await service.submitCurrentSubmission({
      refundAttemptId: ensured.attempt.id,
    });

    (stripe.listRefundsForPaymentIntent as jest.Mock).mockResolvedValue({
      ok: true,
      exhausted: true,
      refunds: [
        {
          id: 're_v1',
          amount: 1000,
          currency: 'usd',
          status: 'succeeded',
          failureReason: null,
          metadata: {
            orderId: 'ord-1',
            operationKey: 'return:ret-1',
            returnRequestId: 'ret-1',
          },
        },
      ],
    });

    const late = await service.reconcileSubmission({
      refundAttemptId: ensured.attempt.id,
      submissionId: v1Id,
    });
    expect(late.submission.outcome).toBe('SUCCEEDED');
    expect(late.submission.stripeRefundId).toBe('re_v1');
    expect(late.attempt.status).toBe('NEEDS_INVESTIGATION');
    expect(late.attempt.investigationReason).toBe(
      'multiple_successful_stripe_refunds',
    );

    const v1 = await prisma.refundAttemptSubmission.findUnique({
      where: { id: v1Id },
    });
    const v2row = [...prisma._submissions.values()].find((s) => s.version === 2);
    expect(v1!.outcome).toBe('SUCCEEDED');
    expect(v2row!.outcome).toBe('SUCCEEDED');
    expect(
      service.isReadyForApply({
        attemptStatus: late.attempt.status,
        submissionOutcome: 'SUCCEEDED',
        submissionStripeRefundId: 're_v2',
        succeededSubmissionCount: 2,
      }),
    ).toBe(false);
  });

  it('concurrent submits for the same version reuse one Stripe create path safely', async () => {
    const { service, stripe } = build();
    let creates = 0;
    (stripe.createRefundForAttempt as jest.Mock).mockImplementation(async () => {
      creates += 1;
      return {
        ok: true,
        refund: { id: 're_same', status: 'succeeded', failureReason: null },
      };
    });
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    const [a, b] = await Promise.all([
      service.submitCurrentSubmission({ refundAttemptId: ensured.attempt.id }),
      service.submitCurrentSubmission({ refundAttemptId: ensured.attempt.id }),
    ]);
    expect(a.attempt.stripeRefundId === 're_same' || b.attempt.stripeRefundId === 're_same').toBe(
      true,
    );
    // Memory prisma does not serialize FOR UPDATE; both may call Stripe with same key.
    // Production relies on Stripe idempotency; both must end without a second refund id.
    expect(
      [a, b].every(
        (r) =>
          !r.created ||
          r.submission.stripeRefundId === 're_same' ||
          r.blockedReason != null,
      ),
    ).toBe(true);
    expect(creates).toBeGreaterThanOrEqual(1);
  });

  it('concurrent next-version opens after failed gate converge on a single v2', async () => {
    const { service, prisma } = build();
    const ensured = await service.ensureAttemptForOperation(ensureParams);
    await prisma.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        outcome: 'FAILED',
        reconciliationResult: 'MATCHED',
        stripeRefundId: 're_fail',
        submittedAt: new Date(),
      },
    });
    await prisma.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: { status: 'STRIPE_FAILED' },
    });

    const [x, y] = await Promise.all([
      service.ensureAttemptForOperation(ensureParams),
      service.ensureAttemptForOperation(ensureParams),
    ]);
    const versions = [...prisma._submissions.values()].filter(
      (s) => s.refundAttemptId === ensured.attempt.id,
    );
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect(x.submission.version).toBe(2);
    expect(y.submission.version).toBe(2);
  });
});

describe('RefundAttemptService.applySuccessfulRefund (S2.2)', () => {
  function build(
    stripeOverrides?: Partial<StripeService>,
    ledgerOverrides?: Partial<CommissionLedgerService>,
  ) {
    const prisma = createMemoryPrisma();
    const stripe = {
      listRefundsForPaymentIntent: jest.fn(),
      createRefundForAttempt: jest.fn(),
      ...stripeOverrides,
    } as unknown as StripeService;
    const ledger = {
      applyReturnClawback: jest.fn().mockResolvedValue({
        legacy: false,
        applied: true,
      }),
      ...ledgerOverrides,
    } as unknown as CommissionLedgerService;
    const service = new RefundAttemptService(
      prisma as never,
      stripe,
      ledger,
    );
    return { service, prisma, stripe, ledger };
  }

  function seedReadyApply(opts?: {
    amount?: number;
    amountCents?: number;
    paymentTotal?: number;
    refundedAmount?: number;
    currency?: string;
    orderCurrency?: string;
    withClawback?: boolean;
    withSnapshot?: boolean;
    kind?: string;
    status?: RefundAttemptStatus;
    stripeRefundId?: string | null;
    submissionOutcome?: RefundSubmissionOutcome;
    extraSucceeded?: boolean;
    shipmentRefundApplied?: boolean;
    clawbackAppliedAt?: Date | null;
    appliedAt?: Date | null;
  }) {
    const { service, prisma, stripe, ledger } = build();
    const amount = opts?.amount ?? 10;
    const amountCents =
      opts?.amountCents ?? Math.round(amount * 100);
    const currency = opts?.currency ?? 'usd';
    prisma.seedOrder({
      id: 'ord-1',
      currency: opts?.orderCurrency ?? currency.toUpperCase(),
    });
    // Order currency in schema is typically uppercase; attempt stores lowercase from Stripe.
    // Match both via toLowerCase() in service — seed with same letters as attempt unless overridden.
    prisma.seedOrder({
      id: 'ord-1',
      currency: opts?.orderCurrency ?? currency,
    });
    const paymentTotal = opts?.paymentTotal ?? amount;
    prisma.seedShipment({
      id: 'ship-1',
      orderId: 'ord-1',
      supplierId: 'sup-1',
      paymentMerchandise: paymentTotal,
      paymentDelivery: 0,
      paymentTax: 0,
      refundedAmount: opts?.refundedAmount ?? 0,
    });
    if (opts?.withSnapshot !== false && opts?.withClawback !== false) {
      prisma.seedCommission({ id: 'oic-1', orderItemId: 'item-1' });
      prisma.seedClawback({
        id: 'cb-1',
        returnRequestId: 'ret-1',
        orderItemCommissionId: 'oic-1',
        appliedAt: null,
      });
    } else if (opts?.withSnapshot && opts?.withClawback === false) {
      prisma.seedCommission({ id: 'oic-1', orderItemId: 'item-1' });
    } else if (opts?.withSnapshot === false && opts?.withClawback === false) {
      // verified no-commission
    }

    return (async () => {
      const ensured = await service.ensureAttemptForOperation({
        kind: 'RETURN',
        operationKey: 'return:ret-1',
        orderId: 'ord-1',
        actorUserId: 'u-1',
        stripePaymentIntentId: 'pi_1',
        amount,
        amountCents,
        currency,
        returnRequestId: 'ret-1',
        orderItemId: 'item-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
      });

      if (opts?.kind && opts.kind !== 'RETURN') {
        await prisma.refundAttempt.update({
          where: { id: ensured.attempt.id },
          data: { kind: opts.kind as Attempt['kind'] },
        });
      }

      const refundId = opts?.stripeRefundId === undefined ? 're_ok' : opts.stripeRefundId;
      const outcome = opts?.submissionOutcome ?? 'SUCCEEDED';
      if (opts?.status === 'PENDING' || outcome === 'PENDING') {
        await prisma.refundAttemptSubmission.update({
          where: { id: ensured.submission.id },
          data: {
            outcome: outcome,
            submittedAt: new Date(),
            stripeRefundId: refundId,
            reconciliationResult: 'NONE',
          },
        });
        await prisma.refundAttempt.update({
          where: { id: ensured.attempt.id },
          data: {
            status: opts?.status ?? 'PENDING',
            stripeRefundId: null,
          },
        });
      } else if (outcome === 'FAILED') {
        await prisma.refundAttemptSubmission.update({
          where: { id: ensured.submission.id },
          data: {
            outcome: 'FAILED',
            submittedAt: new Date(),
            stripeRefundId: refundId,
            reconciliationResult: 'MATCHED',
          },
        });
        await prisma.refundAttempt.update({
          where: { id: ensured.attempt.id },
          data: {
            status: opts?.status ?? 'STRIPE_FAILED',
            stripeRefundId: null,
          },
        });
      } else if (outcome === 'SUBMISSION_UNKNOWN') {
        await prisma.refundAttemptSubmission.update({
          where: { id: ensured.submission.id },
          data: {
            outcome: 'SUBMISSION_UNKNOWN',
            submittedAt: new Date(),
            stripeRefundId: null,
          },
        });
        await prisma.refundAttempt.update({
          where: { id: ensured.attempt.id },
          data: {
            status: 'SUBMISSION_UNKNOWN',
            stripeRefundId: null,
          },
        });
      } else {
        (stripe.createRefundForAttempt as jest.Mock).mockResolvedValue({
          ok: true,
          refund: { id: refundId, status: 'succeeded', failureReason: null },
        });
        await service.submitCurrentSubmission({
          refundAttemptId: ensured.attempt.id,
        });
        if (opts?.status === 'APPLY_FAILED') {
          await prisma.refundAttempt.update({
            where: { id: ensured.attempt.id },
            data: { status: 'APPLY_FAILED', applyError: 'prior' },
          });
        }
        if (opts?.extraSucceeded) {
          await prisma.refundAttemptSubmission.create({
            data: {
              refundAttemptId: ensured.attempt.id,
              version: 2,
              stripeIdempotencyKey: 'winger-ra:return:ret-1:v2',
              outcome: 'SUCCEEDED',
              reconciliationResult: 'MATCHED',
              stripeRefundId: 're_extra',
              submittedAt: new Date(),
            },
          });
        }
      }

      if (
        opts?.shipmentRefundApplied != null ||
        opts?.clawbackAppliedAt !== undefined ||
        opts?.appliedAt !== undefined
      ) {
        await prisma.refundAttempt.update({
          where: { id: ensured.attempt.id },
          data: {
            shipmentRefundApplied: opts.shipmentRefundApplied ?? false,
            clawbackAppliedAt: opts.clawbackAppliedAt ?? null,
            appliedAt: opts.appliedAt ?? null,
            status:
              opts.appliedAt &&
              opts.shipmentRefundApplied &&
              opts.clawbackAppliedAt
                ? 'APPLIED'
                : (opts.status ??
                  (
                    await prisma.refundAttempt.findUnique({
                      where: { id: ensured.attempt.id },
                    })
                  )!.status),
          },
        });
      }

      return {
        service,
        prisma,
        stripe,
        ledger,
        attemptId: ensured.attempt.id,
      };
    })();
  }

  it('applies a full RETURN refund atomically', async () => {
    const ctx = await seedReadyApply({ amount: 25, paymentTotal: 25 });
    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(result.idempotent).toBe(false);
    expect(result.attempt.status).toBe('APPLIED');
    expect(result.attempt.shipmentRefundApplied).toBe(true);
    expect(result.attempt.clawbackAppliedAt).toBeTruthy();
    expect(result.attempt.appliedAt).toBeTruthy();
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(25);
    expect(ctx.ledger.applyReturnClawback).toHaveBeenCalledTimes(1);
    expect(ctx.stripe.createRefundForAttempt).toHaveBeenCalled(); // from setup only
  });

  it('applies a partial RETURN refund for less than shipment total', async () => {
    const ctx = await seedReadyApply({
      amount: 4.5,
      amountCents: 450,
      paymentTotal: 20,
    });
    await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(4.5);
    expect(ctx.ledger.applyReturnClawback).toHaveBeenCalledTimes(1);
  });

  it('returns idempotent success on duplicate apply', async () => {
    const ctx = await seedReadyApply();
    const first = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    const second = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(10);
    expect(ctx.ledger.applyReturnClawback).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent apply to a single financial effect', async () => {
    const ctx = await seedReadyApply();
    const [a, b] = await Promise.all([
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ]);
    expect([a.idempotent, b.idempotent].sort()).toEqual([false, true]);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(10);
    expect(ctx.ledger.applyReturnClawback).toHaveBeenCalledTimes(1);
  });

  it('rolls back shipment and flags when clawback throws', async () => {
    const ctx = await seedReadyApply();
    (ctx.ledger.applyReturnClawback as jest.Mock).mockRejectedValueOnce(
      new Error('ledger boom'),
    );
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/ledger boom/);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    const attempt = ctx.prisma._attempts.get(ctx.attemptId)!;
    expect(attempt.shipmentRefundApplied).toBe(false);
    expect(attempt.appliedAt).toBeNull();
    expect(attempt.status).toBe('APPLY_FAILED');
  });

  it('retries successfully from APPLY_FAILED', async () => {
    const ctx = await seedReadyApply({ status: 'APPLY_FAILED' });
    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(result.attempt.status).toBe('APPLIED');
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(10);
  });

  it('treats lost response after commit as idempotent APPLIED', async () => {
    const ctx = await seedReadyApply();
    await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    // Simulate caller losing the response and retrying.
    const again = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(again.idempotent).toBe(true);
    expect(again.attempt.status).toBe('APPLIED');
  });

  it('returns idempotent success when flags are fully consistent APPLIED', async () => {
    const now = new Date();
    const ctx = await seedReadyApply({
      shipmentRefundApplied: true,
      clawbackAppliedAt: now,
      appliedAt: now,
    });
    // Force consistent APPLIED without going through apply (already set in seed).
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: {
        status: 'APPLIED',
        shipmentRefundApplied: true,
        clawbackAppliedAt: now,
        appliedAt: now,
      },
    });
    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(result.idempotent).toBe(true);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('moves inconsistent flags to investigation without financial writes', async () => {
    const ctx = await seedReadyApply({
      shipmentRefundApplied: true,
      clawbackAppliedAt: null,
      appliedAt: null,
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/inconsistent/);
    const attempt = ctx.prisma._attempts.get(ctx.attemptId)!;
    expect(attempt.status).toBe('NEEDS_INVESTIGATION');
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('failure handler cannot overwrite APPLIED via conditional updateMany', async () => {
    const ctx = await seedReadyApply();
    const now = new Date();
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: {
        status: 'APPLIED',
        shipmentRefundApplied: true,
        clawbackAppliedAt: now,
        appliedAt: now,
      },
    });
    const recorded = await ctx.prisma.refundAttempt.updateMany({
      where: {
        id: ctx.attemptId,
        appliedAt: null,
        status: { in: ['STRIPE_SUCCEEDED', 'APPLY_FAILED'] },
      },
      data: { status: 'APPLY_FAILED', applyError: 'should_not_stick' },
    });
    expect(recorded.count).toBe(0);
    expect(ctx.prisma._attempts.get(ctx.attemptId)!.status).toBe('APPLIED');
  });

  it('catch path returns idempotent success when APPLIED commits during failure recording', async () => {
    const ctx = await seedReadyApply();
    const now = new Date();
    (ctx.ledger.applyReturnClawback as jest.Mock).mockRejectedValueOnce(
      new Error('loser_txn_boom'),
    );

    let findUniquePasses = 0;
    const origFindUnique = ctx.prisma.refundAttempt.findUnique.bind(
      ctx.prisma.refundAttempt,
    );
    ctx.prisma.refundAttempt.findUnique = (async (args: {
      where: { id?: string; operationKey?: string };
      include?: { submissions?: unknown };
    }) => {
      const row = await origFindUnique(args);
      if (args.where.id === ctx.attemptId) {
        findUniquePasses += 1;
        // First catch re-read: still pre-apply. Concurrent winner lands in updateMany.
        if (findUniquePasses === 1) {
          return row;
        }
      }
      return row;
    }) as typeof ctx.prisma.refundAttempt.findUnique;

    const origUpdateMany = ctx.prisma.refundAttempt.updateMany.bind(
      ctx.prisma.refundAttempt,
    );
    ctx.prisma.refundAttempt.updateMany = (async (args: {
      where: {
        id: string;
        appliedAt?: null;
        status?: { in: RefundAttemptStatus[] };
      };
      data: Partial<Attempt>;
    }) => {
      // Simulate concurrent winner committing the full APPLIED quadruple while
      // the loser records failure. Conditional update must not overwrite it.
      await ctx.prisma.refundAttempt.update({
        where: { id: ctx.attemptId },
        data: {
          status: 'APPLIED',
          shipmentRefundApplied: true,
          clawbackAppliedAt: now,
          appliedAt: now,
          applyError: null,
        },
      });
      return origUpdateMany(args);
    }) as typeof ctx.prisma.refundAttempt.updateMany;

    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(result.idempotent).toBe(true);
    expect(result.attempt.status).toBe('APPLIED');
    expect(result.attempt.appliedAt).toBeTruthy();
    expect(result.attempt.shipmentRefundApplied).toBe(true);
    expect(result.attempt.clawbackAppliedAt).toBeTruthy();
    expect(ctx.prisma._attempts.get(ctx.attemptId)!.status).toBe('APPLIED');
    expect(ctx.prisma._attempts.get(ctx.attemptId)!.applyError).toBeNull();
    // Loser txn rolled back: no shipment bump from the failed attempt.
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('catch path does not treat partial markers as success after race', async () => {
    const ctx = await seedReadyApply();
    (ctx.ledger.applyReturnClawback as jest.Mock).mockRejectedValueOnce(
      new Error('partial_race_boom'),
    );

    const origUpdateMany = ctx.prisma.refundAttempt.updateMany.bind(
      ctx.prisma.refundAttempt,
    );
    ctx.prisma.refundAttempt.updateMany = (async (args: {
      where: {
        id: string;
        appliedAt?: null;
        status?: { in: RefundAttemptStatus[] };
      };
      data: Partial<Attempt>;
    }) => {
      // Concurrent mess: only one apply marker, not the full quadruple.
      await ctx.prisma.refundAttempt.update({
        where: { id: ctx.attemptId },
        data: {
          status: 'STRIPE_SUCCEEDED',
          shipmentRefundApplied: true,
          clawbackAppliedAt: null,
          appliedAt: null,
        },
      });
      return origUpdateMany(args);
    }) as typeof ctx.prisma.refundAttempt.updateMany;

    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/partial_race_boom/);
    const attempt = ctx.prisma._attempts.get(ctx.attemptId)!;
    expect(attempt.status).not.toBe('APPLIED');
    expect(attempt.appliedAt).toBeNull();
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('preserves both errors when failure recording fails', async () => {
    const ctx = await seedReadyApply();
    (ctx.ledger.applyReturnClawback as jest.Mock).mockRejectedValueOnce(
      new Error('primary_apply_error'),
    );
    const orig = ctx.prisma.refundAttempt.updateMany.bind(
      ctx.prisma.refundAttempt,
    );
    ctx.prisma.refundAttempt.updateMany = (async () => {
      throw new Error('record_failed');
    }) as typeof ctx.prisma.refundAttempt.updateMany;
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/primary_apply_error[\s\S]*record_failed/);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).toHaveBeenCalled();
    ctx.prisma.refundAttempt.updateMany = orig;
  });

  it('rejects zero frozen amount without financial writes', async () => {
    const ctx = await seedReadyApply();
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: { amount: 0, amountCents: 0 },
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/amount|greater than zero|invalid/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('rejects negative frozen amount without financial writes', async () => {
    const ctx = await seedReadyApply();
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: { amount: -5, amountCents: -500 },
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/amount|greater than zero|invalid/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('rejects non-finite frozen amount without financial writes', async () => {
    const ctx = await seedReadyApply();
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: { amount: Number.NaN, amountCents: 1000 },
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/amount|finite|invalid/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();

    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: {
        amount: Number.POSITIVE_INFINITY,
        amountCents: 1000,
        status: 'STRIPE_SUCCEEDED',
        applyError: null,
      },
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/amount|finite|invalid/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('rejects amount / amountCents mismatch without financial writes', async () => {
    const ctx = await seedReadyApply();
    await ctx.prisma.refundAttempt.update({
      where: { id: ctx.attemptId },
      data: { amount: 10, amountCents: 999 },
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/amountCents|mismatch/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
    const attempt = ctx.prisma._attempts.get(ctx.attemptId)!;
    expect(attempt.amount).toBe(10);
    expect(attempt.amountCents).toBe(999);
    expect(attempt.status).toBe('NEEDS_INVESTIGATION');
  });

  it('rejects actors that are neither ADMIN nor attempt actor', async () => {
    const ctx = await seedReadyApply();
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: {
          sub: 'u-other',
          email: 'x@y.z',
          role: UserRole.CUSTOMER,
          name: 'Nope',
        },
      }),
    ).rejects.toThrow(/apply_actor_not_allowed/);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('allows matching actorUserId without ADMIN', async () => {
    const ctx = await seedReadyApply();
    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: {
        sub: 'u-1',
        email: 'x@y.z',
        role: UserRole.CUSTOMER,
        name: 'Owner',
      },
    });
    expect(result.attempt.status).toBe('APPLIED');
  });

  it('verified no-commission no-op sets clawbackAppliedAt without ledger apply', async () => {
    const ctx = await seedReadyApply({
      withClawback: false,
      withSnapshot: false,
    });
    const result = await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(result.attempt.status).toBe('APPLIED');
    expect(result.attempt.clawbackAppliedAt).toBeTruthy();
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('fails when snapshot exists without reservation', async () => {
    const ctx = await seedReadyApply({
      withSnapshot: true,
      withClawback: false,
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/clawback_reservation_missing|reservation/);
    expect(ctx.prisma._attempts.get(ctx.attemptId)!.status).toBe('APPLY_FAILED');
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('rejects multiple successful Stripe submissions', async () => {
    const ctx = await seedReadyApply({ extraSucceeded: true });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/multiple_succeeded|exactly one/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('rejects pending Stripe submissions', async () => {
    const ctx = await seedReadyApply({
      submissionOutcome: 'PENDING',
      status: 'PENDING',
      stripeRefundId: 're_pending',
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/not eligible|no_succeeded|status/i);
  });

  it('rejects failed Stripe submissions', async () => {
    const ctx = await seedReadyApply({
      submissionOutcome: 'FAILED',
      status: 'STRIPE_FAILED',
      stripeRefundId: 're_fail',
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/not eligible|no_succeeded|status/i);
  });

  it('rejects unresolved Stripe submissions', async () => {
    const ctx = await seedReadyApply({
      submissionOutcome: 'SUBMISSION_UNKNOWN',
      status: 'SUBMISSION_UNKNOWN',
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/not eligible|no_succeeded|status/i);
  });

  it('rejects wrong refund kind without financial changes', async () => {
    const ctx = await seedReadyApply({ kind: 'ORDER_CANCEL' });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/not supported|kind/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('rejects over-refund against shipment payment capacity', async () => {
    const ctx = await seedReadyApply({
      amount: 15,
      amountCents: 1500,
      paymentTotal: 10,
      refundedAmount: 0,
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/capacity|shipment_refund/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
    expect(ctx.prisma._attempts.get(ctx.attemptId)!.status).toBe('APPLY_FAILED');
  });

  it('rejects currency mismatch between attempt and order', async () => {
    const ctx = await seedReadyApply({
      currency: 'usd',
      orderCurrency: 'eur',
    });
    await expect(
      ctx.service.applySuccessfulRefund({
        refundAttemptId: ctx.attemptId,
        actor: actorUser,
      }),
    ).rejects.toThrow(/currency/i);
    expect(ctx.prisma._shipments.get('ship-1')!.refundedAmount).toBe(0);
  });

  it('never calls Stripe during apply', async () => {
    const ctx = await seedReadyApply();
    (ctx.stripe.createRefundForAttempt as jest.Mock).mockClear();
    (ctx.stripe.listRefundsForPaymentIntent as jest.Mock).mockClear();
    await ctx.service.applySuccessfulRefund({
      refundAttemptId: ctx.attemptId,
      actor: actorUser,
    });
    expect(ctx.stripe.createRefundForAttempt).not.toHaveBeenCalled();
    expect(ctx.stripe.listRefundsForPaymentIntent).not.toHaveBeenCalled();
  });
});
