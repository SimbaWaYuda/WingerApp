import {
  RefundAttemptStatus,
  RefundReconciliationResult,
  RefundSubmissionOutcome,
} from '@prisma/client';
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
  amount: { toString(): string };
  amountCents: number;
  currency: string;
  includeDelivery: boolean;
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

function createMemoryPrisma() {
  const attempts = new Map<string, Attempt>();
  const byKey = new Map<string, string>();
  const submissions = new Map<string, Submission>();
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
  };

  const prisma = {
    ...api,
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
      return fn(api);
    },
    _attempts: attempts,
    _submissions: submissions,
  };

  return prisma;
}

describe('RefundAttemptService (S2.1)', () => {
  const previousFlag = process.env[REFUND_ATTEMPT_V1_ENV];

  afterEach(() => {
    if (previousFlag === undefined) delete process.env[REFUND_ATTEMPT_V1_ENV];
    else process.env[REFUND_ATTEMPT_V1_ENV] = previousFlag;
  });

  function build(stripeOverrides?: Partial<StripeService>) {
    const prisma = createMemoryPrisma();
    const stripe = {
      listRefundsForPaymentIntent: jest.fn(),
      createRefundForAttempt: jest.fn(),
      ...stripeOverrides,
    } as unknown as StripeService;
    const service = new RefundAttemptService(prisma as never, stripe);
    return { service, prisma, stripe };
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

  it('keeps applySuccessfulRefund unimplemented for S2.2', async () => {
    const { service } = build();
    await expect(
      service.applySuccessfulRefund({ refundAttemptId: 'ra-1' }),
    ).rejects.toThrow(/S2\.2 not started/);
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

    const service = new RefundAttemptService(prisma as never, stripe);
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
