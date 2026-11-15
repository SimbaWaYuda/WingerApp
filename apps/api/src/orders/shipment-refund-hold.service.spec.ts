import {
  LegacyStripeOutcome,
  ReturnRefundDrive,
  ReturnRefundStatus,
  ShipmentRefundHoldStatus,
} from '@prisma/client';
import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';
import { ShipmentRefundHoldError } from './shipment-refund-hold.types';

type HoldRow = {
  id: string;
  returnRequestId: string;
  orderShipmentId: string;
  supplierId: string;
  amount: number;
  amountCents: number;
  currency: string;
  returnedMerchandise: number;
  includeDelivery: boolean;
  proofJson: Record<string, unknown>;
  status: ShipmentRefundHoldStatus;
  refundAttemptId: string | null;
  legacyStripeClaimedAt: Date | null;
  legacyStripeOutcome: LegacyStripeOutcome | null;
};

function buildMemory() {
  const holds = new Map<string, HoldRow>();
  const byReturn = new Map<string, string>();
  const returns = new Map<
    string,
    {
      id: string;
      refundStatus: ReturnRefundStatus;
      refundDrive: ReturnRefundDrive;
      refundAbandonRequestedAt: Date | null;
      refundedAt: Date | null;
      stripePaymentIntentId: string | null;
    }
  >();
  const shipments = new Map<
    string,
    {
      id: string;
      orderId: string;
      supplierId: string;
      supplierName: string;
      merchandise: number;
      deliveryFee: number;
      merchandiseTax: number;
      deliveryTax: number;
      paymentMerchandise: number;
      paymentDelivery: number;
      paymentTax: number;
      refundedAmount: number;
    }
  >();
  const evidenceRows: Array<Record<string, unknown>> = [];
  let seq = 0;
  let evidenceSeq = 0;

  const api = {
    async $executeRaw() {
      return 1;
    },
    returnRequest: {
      async findUniqueOrThrow(args: {
        where: { id: string };
        include?: { order?: { select?: { stripePaymentIntentId?: boolean } } };
      }) {
        const row = returns.get(args.where.id);
        if (!row) throw new Error('rr missing');
        if (args.include?.order) {
          return {
            ...row,
            order: { stripePaymentIntentId: row.stripePaymentIntentId },
          };
        }
        return { ...row };
      },
      async update(args: {
        where: { id: string };
        data: Partial<{
          refundAbandonRequestedAt: Date;
          refundStatus: ReturnRefundStatus;
          refundedAt: Date;
        }>;
      }) {
        const row = returns.get(args.where.id)!;
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    shipmentRefundHoldLegacyEvidence: {
      async create(args: { data: Record<string, unknown> }) {
        const row = {
          id: `ev-${++evidenceSeq}`,
          observedAt: new Date(),
          createdAt: new Date(),
          ...args.data,
        };
        evidenceRows.push(row);
        return { ...row };
      },
      async findMany(args?: {
        where?: { shipmentRefundHoldId?: string; returnRequestId?: string };
        orderBy?: { observedAt: 'asc' | 'desc' };
      }) {
        let rows = [...evidenceRows];
        if (args?.where?.shipmentRefundHoldId) {
          rows = rows.filter(
            (r) => r.shipmentRefundHoldId === args.where!.shipmentRefundHoldId,
          );
        }
        if (args?.where?.returnRequestId) {
          rows = rows.filter(
            (r) => r.returnRequestId === args.where!.returnRequestId,
          );
        }
        return rows;
      },
    },
    orderShipment: {
      async findUniqueOrThrow(args: { where: { id: string } }) {
        const row = shipments.get(args.where.id);
        if (!row) throw new Error('ship missing');
        return { ...row };
      },
      async update(args: {
        where: { id: string };
        data: { refundedAmount: { toString(): string } | number };
      }) {
        const row = shipments.get(args.where.id)!;
        row.refundedAmount = Number(args.data.refundedAmount);
        return { ...row };
      },
    },
    shipmentRefundHold: {
      async findUnique(args: {
        where: { returnRequestId?: string; id?: string };
      }) {
        if (args.where.returnRequestId) {
          const id = byReturn.get(args.where.returnRequestId);
          return id ? { ...holds.get(id)! } : null;
        }
        if (args.where.id) {
          const row = holds.get(args.where.id);
          return row ? { ...row } : null;
        }
        return null;
      },
      async findUniqueOrThrow(args: {
        where: { returnRequestId?: string; id?: string };
      }) {
        const row = await api.shipmentRefundHold.findUnique(args);
        if (!row) throw new Error('hold missing');
        return row;
      },
      async aggregate(args: {
        where: { orderShipmentId: string; status: ShipmentRefundHoldStatus };
        _sum: { amount: true };
      }) {
        let sum = 0;
        for (const h of holds.values()) {
          if (
            h.orderShipmentId === args.where.orderShipmentId &&
            h.status === args.where.status
          ) {
            sum += h.amount;
          }
        }
        return { _sum: { amount: sum } };
      },
      async create(args: { data: Omit<HoldRow, 'id'> & { amount: unknown } }) {
        const id = `hold-${++seq}`;
        const row: HoldRow = {
          id,
          returnRequestId: args.data.returnRequestId,
          orderShipmentId: args.data.orderShipmentId,
          supplierId: args.data.supplierId,
          amount: Number(args.data.amount),
          amountCents: args.data.amountCents,
          currency: args.data.currency,
          returnedMerchandise: Number(args.data.returnedMerchandise),
          includeDelivery: args.data.includeDelivery,
          proofJson: args.data.proofJson as Record<string, unknown>,
          status: args.data.status,
          refundAttemptId: args.data.refundAttemptId ?? null,
          legacyStripeClaimedAt: null,
          legacyStripeOutcome: null,
        };
        holds.set(id, row);
        byReturn.set(row.returnRequestId, id);
        return { ...row };
      },
      async update(args: { where: { id: string }; data: Partial<HoldRow> }) {
        const row = holds.get(args.where.id)!;
        Object.assign(row, args.data);
        return { ...row };
      },
    },
    refundAttempt: {
      async findFirst() {
        return null;
      },
      async findUniqueOrThrow() {
        throw new Error('no attempt');
      },
      async update() {
        return {};
      },
    },
    refundAttemptSubmission: {
      async findMany() {
        return [];
      },
    },
  };

  const prisma = {
    ...api,
    /**
     * Realistic rollback: snapshot mutable state, restore if the callback throws.
     * Required so late-success durability tests cannot false-green.
     */
    async $transaction<T>(fn: (tx: typeof api) => Promise<T>) {
      const snapHolds = new Map(
        [...holds.entries()].map(([k, v]) => [k, { ...v, proofJson: { ...v.proofJson } }]),
      );
      const snapByReturn = new Map(byReturn);
      const snapReturns = new Map(
        [...returns.entries()].map(([k, v]) => [k, { ...v }]),
      );
      const snapShipments = new Map(
        [...shipments.entries()].map(([k, v]) => [k, { ...v }]),
      );
      const snapEvidence = evidenceRows.map((r) => ({ ...r }));
      const snapSeq = seq;
      const snapEvidenceSeq = evidenceSeq;
      try {
        return await fn(api);
      } catch (error) {
        holds.clear();
        for (const [k, v] of snapHolds) holds.set(k, v);
        byReturn.clear();
        for (const [k, v] of snapByReturn) byReturn.set(k, v);
        returns.clear();
        for (const [k, v] of snapReturns) returns.set(k, v);
        shipments.clear();
        for (const [k, v] of snapShipments) shipments.set(k, v);
        evidenceRows.length = 0;
        evidenceRows.push(...snapEvidence);
        seq = snapSeq;
        evidenceSeq = snapEvidenceSeq;
        throw error;
      }
    },
    _holds: holds,
    _returns: returns,
    _shipments: shipments,
    _evidence: evidenceRows,
    seedReturn(row: {
      id: string;
      refundStatus?: ReturnRefundStatus;
      refundDrive?: ReturnRefundDrive;
      refundAbandonRequestedAt?: Date | null;
      stripePaymentIntentId?: string | null;
    }) {
      returns.set(row.id, {
        id: row.id,
        refundStatus: row.refundStatus ?? ReturnRefundStatus.PENDING,
        refundDrive: row.refundDrive ?? ReturnRefundDrive.UNCLAIMED,
        refundAbandonRequestedAt: row.refundAbandonRequestedAt ?? null,
        refundedAt: null,
        stripePaymentIntentId: row.stripePaymentIntentId ?? 'pi_1',
      });
    },
    seedShipment(row: {
      id: string;
      paymentMerchandise: number;
      paymentDelivery?: number;
      paymentTax?: number;
      refundedAmount?: number;
      merchandise?: number;
    }) {
      shipments.set(row.id, {
        id: row.id,
        orderId: 'ord-1',
        supplierId: 'sup-1',
        supplierName: 'Sup',
        merchandise: row.merchandise ?? row.paymentMerchandise,
        deliveryFee: row.paymentDelivery ?? 0,
        merchandiseTax: 0,
        deliveryTax: 0,
        paymentMerchandise: row.paymentMerchandise,
        paymentDelivery: row.paymentDelivery ?? 0,
        paymentTax: row.paymentTax ?? 0,
        refundedAmount: row.refundedAmount ?? 0,
      });
    },
  };

  const ledger = {
    applyReturnClawback: jest.fn().mockResolvedValue({ legacy: false, applied: true }),
  };
  const service = new ShipmentRefundHoldService(prisma as never, ledger as never);
  return { service, prisma, ledger, holds };
}

const actor: AuthUser = {
  sub: 'admin-1',
  email: 'a@b.co',
  role: UserRole.ADMIN,
  name: 'Admin',
};

describe('ShipmentRefundHoldService (S2.3)', () => {
  it('reserves a frozen snapshot and reuses it on second reserve', async () => {
    const { service, prisma, holds } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 100,
      merchandise: 100,
    });

    const first = await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 40,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    expect(first.amount).toBe(40);
    expect(first.amountCents).toBe(4000);
    expect(first.proofJson.calculatedRefundAmount).toBe(40);
    expect(first.proofJson.refundedAmountBefore).toBe(0);

    const second = await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 99,
        includeDelivery: true,
        siblingHadLiveLine: false,
      }),
    );
    expect(second.id).toBe(first.id);
    expect(second.amount).toBe(40);
    expect(second.includeDelivery).toBe(false);
    expect(holds.size).toBe(1);
  });

  it('rejects insufficient capacity without silently shrinking the calculated amount', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-other' });
    prisma.seedReturn({ id: 'ret-2' });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 100,
      merchandise: 100,
      refundedAmount: 80,
    });
    // 100 - 80 refunded = 20 available; first hold takes it all.
    await prisma.$transaction(async (tx) => {
      await service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-other',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 20,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
    });
    await expect(
      prisma.$transaction((tx) =>
        service.reserveInTransaction(tx as never, {
          returnRequestId: 'ret-2',
          orderShipmentId: 'ship-1',
          supplierId: 'sup-1',
          currency: 'usd',
          returnedMerchandise: 10,
          includeDelivery: false,
          siblingHadLiveLine: true,
        }),
      ),
    ).rejects.toThrow(ShipmentRefundHoldError);

    // calculated $40 with only $30 available must reject — not reserve $30.
    prisma.seedReturn({ id: 'ret-3' });
    prisma.seedShipment({
      id: 'ship-2',
      paymentMerchandise: 100,
      merchandise: 100,
      refundedAmount: 70,
    });
    await expect(
      prisma.$transaction((tx) =>
        service.reserveInTransaction(tx as never, {
          returnRequestId: 'ret-3',
          orderShipmentId: 'ship-2',
          supplierId: 'sup-1',
          currency: 'usd',
          returnedMerchandise: 40,
          includeDelivery: false,
          siblingHadLiveLine: true,
        }),
      ),
    ).rejects.toThrow(/available 30/);
  });

  it('marks freshClaim false for unresolved LEGACY reuse', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 25,
      merchandise: 25,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 25,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    const first = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: 'ret-1',
    });
    expect(first.freshClaim).toBe(true);
    const again = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: 'ret-1',
    });
    expect(again.freshClaim).toBe(false);
    expect(again.legacyStripeOutcome).toBeNull();
  });

  it('consumes a hold exactly once and never reactivates RELEASED', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.ATTEMPT });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 50,
      merchandise: 50,
    });
    const hold = await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 50,
        includeDelivery: false,
        siblingHadLiveLine: true,
        refundAttemptId: 'att-1',
      }),
    );

    const first = await prisma.$transaction((tx) =>
      service.consumeHoldForApplyTx(tx as never, {
        returnRequestId: 'ret-1',
        refundAttemptId: 'att-1',
        expectedAmount: hold.amount,
        expectedAmountCents: hold.amountCents,
        expectedCurrency: 'usd',
        orderShipmentId: 'ship-1',
      }),
    );
    expect(first.consumed).toBe(true);

    const second = await prisma.$transaction((tx) =>
      service.consumeHoldForApplyTx(tx as never, {
        returnRequestId: 'ret-1',
        refundAttemptId: 'att-1',
        expectedAmount: hold.amount,
        expectedAmountCents: hold.amountCents,
        expectedCurrency: 'usd',
        orderShipmentId: 'ship-1',
      }),
    );
    expect(second.alreadyConsumed).toBe(true);

    await prisma.shipmentRefundHold.update({
      where: { id: hold.id },
      data: { status: ShipmentRefundHoldStatus.RELEASED },
    });
    // Reactivation via reserve must fail.
    await expect(
      prisma.$transaction((tx) =>
        service.reserveInTransaction(tx as never, {
          returnRequestId: 'ret-1',
          orderShipmentId: 'ship-1',
          supplierId: 'sup-1',
          currency: 'usd',
          returnedMerchandise: 50,
          includeDelivery: false,
          siblingHadLiveLine: true,
        }),
      ),
    ).rejects.toThrow(/RELEASED/);
  });

  it('claims LEGACY Stripe before network and treats null outcome as unresolved', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 25,
      merchandise: 25,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 25,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );

    const claimed = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: 'ret-1',
    });
    expect(claimed.legacyStripeClaimedAt).toBeTruthy();
    expect(claimed.legacyStripeOutcome).toBeNull();
    expect(claimed.freshClaim).toBe(true);

    // Second claim while unresolved reuses — does not create independent refund.
    const again = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: 'ret-1',
    });
    expect(again.id).toBe(claimed.id);
    expect(again.legacyStripeOutcome).toBeNull();
    expect(again.freshClaim).toBe(false);
  });

  it('blocks new LEGACY claims after abandonment unless SUCCESS_PENDING_FINALIZE', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({
      id: 'ret-1',
      refundDrive: ReturnRefundDrive.LEGACY,
      refundAbandonRequestedAt: new Date(),
    });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 25,
      merchandise: 25,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 25,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );

    await expect(
      service.claimLegacyStripeBeforeNetwork({ returnRequestId: 'ret-1' }),
    ).rejects.toThrow(/abandonment/);
  });

  it('finalises SUCCESS_PENDING_FINALIZE atomically and consumes hold', async () => {
    const { service, prisma, ledger } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 40,
      merchandise: 40,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 40,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: 'ret-1' });
    await service.recordLegacyStripeOutcome({
      returnRequestId: 'ret-1',
      outcome: 'SUCCESS_PENDING_FINALIZE',
    });

    const result = await service.finalizeLegacySuccessfulRefund({
      returnRequestId: 'ret-1',
      actor,
    });
    expect(result.hold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
    expect(prisma._shipments.get('ship-1')!.refundedAmount).toBe(40);
    expect(prisma._returns.get('ret-1')!.refundStatus).toBe(
      ReturnRefundStatus.ISSUED,
    );
    expect(ledger.applyReturnClawback).toHaveBeenCalled();

    const again = await service.finalizeLegacySuccessfulRefund({
      returnRequestId: 'ret-1',
      actor,
    });
    expect(again.idempotent).toBe(true);
  });

  it('releases LEGACY hold after FAILED_TERMINAL + abandonment', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 30,
      merchandise: 30,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 30,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: 'ret-1' });
    await service.recordLegacyStripeOutcome({
      returnRequestId: 'ret-1',
      outcome: 'FAILED_TERMINAL',
    });

    await service.requestAbandonment({ returnRequestId: 'ret-1' });
    const hold = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(hold?.status).toBe(ShipmentRefundHoldStatus.RELEASED);
  });

  it('retains RESERVED when abandon races with null (unresolved) LEGACY outcome', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 30,
      merchandise: 30,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 30,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: 'ret-1' });
    // outcome left null — crash after claim
    await service.requestAbandonment({ returnRequestId: 'ret-1' });
    const hold = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(hold?.status).toBe(ShipmentRefundHoldStatus.RESERVED);
  });

  it('appends LEGACY evidence without mutating proofJson', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 40,
      merchandise: 40,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 40,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    const before = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    const proofBefore = JSON.stringify(before!.proofJson);

    await service.appendLegacyStripeEvidence({
      returnRequestId: 'ret-1',
      stripePaymentIntentId: 'pi_1',
      stripeRefundId: 're_1',
      stripeStatus: 'pending',
      source: 'FRESH_CREATE',
      classification: 'PENDING',
    });
    await service.appendLegacyStripeEvidence({
      returnRequestId: 'ret-1',
      stripePaymentIntentId: 'pi_1',
      stripeRefundId: 're_1',
      stripeStatus: 'succeeded',
      source: 'RECOVERY_LIST',
      classification: 'SUCCEEDED',
    });

    const after = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(JSON.stringify(after!.proofJson)).toBe(proofBefore);
    expect(after!.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(after!.legacyStripeOutcome).toBeNull();

    const evidence = await prisma.shipmentRefundHoldLegacyEvidence.findMany({
      where: { returnRequestId: 'ret-1' },
    });
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toEqual(
      expect.objectContaining({
        shipmentRefundHoldId: before!.id,
        returnRequestId: 'ret-1',
        stripeRefundId: 're_1',
        stripeStatus: 'pending',
        classification: 'PENDING',
        source: 'FRESH_CREATE',
      }),
    );
    expect(evidence[1]).toEqual(
      expect.objectContaining({
        stripeStatus: 'succeeded',
        classification: 'SUCCEEDED',
        source: 'RECOVERY_LIST',
      }),
    );
  });

  async function releaseLegacyHold(service: ShipmentRefundHoldService, prisma: ReturnType<typeof buildMemory>['prisma']) {
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 30,
      merchandise: 30,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 30,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: 'ret-1' });
    await service.recordLegacyStripeOutcome({
      returnRequestId: 'ret-1',
      outcome: 'FAILED_TERMINAL',
    });
    await service.requestAbandonment({ returnRequestId: 'ret-1' });
  }

  it('persists late success after RELEASED then fails closed without reactivating', async () => {
    const { service, prisma, ledger } = buildMemory();
    await releaseLegacyHold(service, prisma);
    const released = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(released?.status).toBe(ShipmentRefundHoldStatus.RELEASED);
    const proofBefore = JSON.stringify(released!.proofJson);

    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: 'ret-1',
        stripePaymentIntentId: 'pi_1',
        stripeRefundId: 're_late',
        stripeStatus: 'succeeded',
        source: 'RECOVERY_LIST',
        classification: 'SUCCEEDED',
      }),
    ).rejects.toMatchObject({ code: 'legacy_late_success_after_released' });

    const after = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(after?.status).toBe(ShipmentRefundHoldStatus.RELEASED);
    expect(after?.legacyStripeOutcome).toBe(LegacyStripeOutcome.FAILED_TERMINAL);
    expect(JSON.stringify(after!.proofJson)).toBe(proofBefore);
    const evidence = await prisma.shipmentRefundHoldLegacyEvidence.findMany({
      where: { returnRequestId: 'ret-1' },
    });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toEqual(
      expect.objectContaining({
        classification: 'LATE_SUCCESS_AFTER_RELEASED',
        stripeRefundId: 're_late',
      }),
    );
    expect(ledger.applyReturnClawback).not.toHaveBeenCalled();
  });

  it('repeated late-success observations remain append-only after commit+error', async () => {
    const { service, prisma } = buildMemory();
    await releaseLegacyHold(service, prisma);

    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: 'ret-1',
        stripePaymentIntentId: 'pi_1',
        stripeRefundId: 're_late_1',
        stripeStatus: 'succeeded',
        source: 'RECOVERY_LIST',
        classification: 'SUCCEEDED',
      }),
    ).rejects.toMatchObject({ code: 'legacy_late_success_after_released' });
    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: 'ret-1',
        stripePaymentIntentId: 'pi_1',
        stripeRefundId: 're_late_2',
        stripeStatus: 'succeeded',
        source: 'RECOVERY_LIST',
        classification: 'SUCCEEDED',
      }),
    ).rejects.toMatchObject({ code: 'legacy_late_success_after_released' });

    const hold = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(hold?.status).toBe(ShipmentRefundHoldStatus.RELEASED);
    const evidence = await prisma.shipmentRefundHoldLegacyEvidence.findMany({
      where: { returnRequestId: 'ret-1' },
    });
    expect(evidence).toHaveLength(2);
    expect(evidence.map((e) => e.stripeRefundId)).toEqual([
      're_late_1',
      're_late_2',
    ]);
  });

  it('rolls back evidence when insertion fails inside the transaction', async () => {
    const { service, prisma } = buildMemory();
    await releaseLegacyHold(service, prisma);
    const originalCreate = prisma.shipmentRefundHoldLegacyEvidence.create;
    prisma.shipmentRefundHoldLegacyEvidence.create = jest
      .fn()
      .mockRejectedValue(new Error('insert failed'));

    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: 'ret-1',
        stripePaymentIntentId: 'pi_1',
        stripeRefundId: 're_fail',
        stripeStatus: 'succeeded',
        source: 'RECOVERY_LIST',
        classification: 'SUCCEEDED',
      }),
    ).rejects.toThrow(/insert failed/);

    const hold = await prisma.shipmentRefundHold.findUnique({
      where: { returnRequestId: 'ret-1' },
    });
    expect(hold?.status).toBe(ShipmentRefundHoldStatus.RELEASED);
    expect(
      await prisma.shipmentRefundHoldLegacyEvidence.findMany({
        where: { returnRequestId: 'ret-1' },
      }),
    ).toHaveLength(0);
    prisma.shipmentRefundHoldLegacyEvidence.create = originalCreate;
  });

  it('transaction harness rolls back writes when the callback throws', async () => {
    const { prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.shipmentRefundHoldLegacyEvidence.create({
          data: {
            shipmentRefundHoldId: 'hold-x',
            returnRequestId: 'ret-1',
            stripePaymentIntentId: 'pi_1',
            stripeRefundId: 're_rollback',
            stripeStatus: 'succeeded',
            source: 'RECOVERY_LIST',
            classification: 'LATE_SUCCESS_AFTER_RELEASED',
          },
        });
        expect(
          await tx.shipmentRefundHoldLegacyEvidence.findMany({
            where: { returnRequestId: 'ret-1' },
          }),
        ).toHaveLength(1);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow(/force rollback/);

    expect(
      await prisma.shipmentRefundHoldLegacyEvidence.findMany({
        where: { returnRequestId: 'ret-1' },
      }),
    ).toHaveLength(0);
  });

  it('rejects evidence with mismatched PaymentIntent', async () => {
    const { service, prisma } = buildMemory();
    prisma.seedReturn({ id: 'ret-1', refundDrive: ReturnRefundDrive.LEGACY });
    prisma.seedShipment({
      id: 'ship-1',
      paymentMerchandise: 20,
      merchandise: 20,
    });
    await prisma.$transaction((tx) =>
      service.reserveInTransaction(tx as never, {
        returnRequestId: 'ret-1',
        orderShipmentId: 'ship-1',
        supplierId: 'sup-1',
        currency: 'usd',
        returnedMerchandise: 20,
        includeDelivery: false,
        siblingHadLiveLine: true,
      }),
    );

    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: 'ret-1',
        stripePaymentIntentId: 'pi_other',
        stripeRefundId: 're_1',
        stripeStatus: 'pending',
        source: 'FRESH_CREATE',
        classification: 'PENDING',
      }),
    ).rejects.toMatchObject({ code: 'legacy_evidence_pi_mismatch' });
    expect(
      await prisma.shipmentRefundHoldLegacyEvidence.findMany({
        where: { returnRequestId: 'ret-1' },
      }),
    ).toHaveLength(0);
  });
});
