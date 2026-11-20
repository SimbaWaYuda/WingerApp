import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CommissionActorType,
  CommissionRecognitionJobStatus,
  CommissionRecognitionStatus,
  OrderStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { ROLES_KEY } from '../auth/roles.decorator';
import { CommissionLedgerService, toAdminAllocation, toAdminCreditApplication } from './commission-ledger.service';
import { lipaSuppliersReadyForPayment } from './commission-ledger.math';
import { CommissionRecognitionRecovery } from './commission-recognition.recovery';
import { CommissionsController } from './commissions.controller';

const admin: AuthUser = {
  sub: 'admin-1',
  email: 'admin@winger.example',
  name: 'Admin',
  role: UserRole.ADMIN,
};

function lipaHarness(options: {
  paymentMode: string;
  paymentStatus?: string;
  items: { id: string; supplierId: string; status: string }[];
  evidence: { id: string; supplierId: string; status: string }[];
  jobs?: { orderItemId: string; status: string }[];
}) {
  const state = {
    order: {
      id: 'order-1',
      paymentMode: options.paymentMode,
      paymentStatus: options.paymentStatus ?? 'PENDING',
      items: options.items,
    },
    evidence: options.evidence.map((row) => ({ ...row, orderId: 'order-1' })),
    jobs: (options.jobs ?? []).map((job) => ({ ...job, orderId: 'order-1' })),
    paidWrites: 0,
  };
  let tail: Promise<void> = Promise.resolve();
  const prisma: any = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx: any = {
        customerPaymentEvidence: {
          findUnique: async ({ where }: { where: { id: string } }) =>
            state.evidence.find((row) => row.id === where.id) ?? null,
          findMany: async ({
            where,
          }: {
            where: { orderId: string; status: string; supplierId: { in: string[] } };
          }) =>
            state.evidence.filter(
              (row) =>
                row.orderId === where.orderId &&
                row.status === where.status &&
                where.supplierId.in.includes(row.supplierId),
            ),
          update: async ({
            where,
            data,
          }: {
            where: { id: string };
            data: Record<string, unknown>;
          }) => {
            const row = state.evidence.find((item) => item.id === where.id);
            if (!row) throw new Error('missing evidence');
            Object.assign(row, data);
            return row;
          },
        },
        customerPaymentEvidenceOpen: { deleteMany: async () => ({ count: 1 }) },
        order: {
          findUnique: async ({ where, select }: { where: { id: string }; select?: object }) => {
            if (where.id !== state.order.id) return null;
            if (select) {
              return {
                paymentMode: state.order.paymentMode,
                paymentStatus: state.order.paymentStatus,
              };
            }
            return state.order;
          },
          updateMany: async ({
            where,
            data,
          }: {
            where: { id: string; paymentMode: string; paymentStatus: string };
            data: { paymentStatus: string };
          }) => {
            if (
              state.order.id === where.id &&
              state.order.paymentMode === where.paymentMode &&
              state.order.paymentStatus === where.paymentStatus
            ) {
              state.order.paymentStatus = data.paymentStatus;
              state.paidWrites += 1;
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
        commissionRecognitionJob: {
          count: async () => state.jobs.filter((job) => job.status !== 'COMPLETED').length,
          createMany: async ({
            data,
            skipDuplicates,
          }: {
            data: { orderItemId: string }[];
            skipDuplicates?: boolean;
          }) => {
            for (const row of data) {
              if (skipDuplicates && state.jobs.some((job) => job.orderItemId === row.orderItemId)) {
                continue;
              }
              state.jobs.push({ ...row, orderId: 'order-1', status: 'PENDING' });
            }
            return { count: data.length };
          },
        },
      };
      tx.$queryRaw = async () => {
        if (!tx.held) {
          const previous = tail;
          let release = () => {};
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          tx.release = release;
          tx.held = true;
          await previous;
        }
        return [{ id: state.order.id }];
      };
      try {
        return await fn(tx);
      } finally {
        tx.release?.();
      }
    },
  };
  return {
    state,
    service: new CommissionLedgerService(prisma, { record: async () => undefined } as never, {} as never),
  };
}

function live(id: string, supplierId: string) {
  return { id, supplierId, status: OrderStatus.PROCESSING };
}

describe('Lipa evidence payment confirmation', () => {
  it('requires every live Lipa supplier and ignores card or COD orders', () => {
    expect(
      lipaSuppliersReadyForPayment({
        paymentMode: 'lipa',
        liveSupplierIds: ['s-a'],
        verifiedSupplierIds: ['s-a'],
      }),
    ).toBe(true);
    expect(
      lipaSuppliersReadyForPayment({
        paymentMode: 'lipa',
        liveSupplierIds: ['s-a', 's-b'],
        verifiedSupplierIds: ['s-a'],
      }),
    ).toBe(false);
    expect(
      lipaSuppliersReadyForPayment({
        paymentMode: 'cod',
        liveSupplierIds: ['s-a'],
        verifiedSupplierIds: ['s-a'],
      }),
    ).toBe(false);
    expect(
      lipaSuppliersReadyForPayment({
        paymentMode: 'card',
        liveSupplierIds: ['s-a'],
        verifiedSupplierIds: ['s-a'],
      }),
    ).toBe(false);
  });

  it('marks a single-supplier Lipa order paid and enqueues recognition', async () => {
    const { state, service } = lipaHarness({
      paymentMode: 'lipa',
      items: [live('item-a', 's-a')],
      evidence: [{ id: 'ev-a', supplierId: 's-a', status: 'SUBMITTED' }],
    });
    const result = await service.reviewLipaEvidence(admin, 'ev-a', { approve: true });
    expect(state.order.paymentStatus).toBe('PAID');
    expect(result.recoveryRequired).toBe(true);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0].orderItemId).toBe('item-a');
  });

  it('keeps a two-supplier Lipa order pending until the final supplier is verified', async () => {
    const { state, service } = lipaHarness({
      paymentMode: 'lipa',
      items: [live('item-a', 's-a'), live('item-b', 's-b')],
      evidence: [
        { id: 'ev-a', supplierId: 's-a', status: 'SUBMITTED' },
        { id: 'ev-b', supplierId: 's-b', status: 'SUBMITTED' },
      ],
    });
    const first = await service.reviewLipaEvidence(admin, 'ev-a', { approve: true });
    expect(state.order.paymentStatus).toBe('PENDING');
    expect(first.recoveryRequired).toBe(false);
    expect(state.jobs).toHaveLength(0);

    const second = await service.reviewLipaEvidence(admin, 'ev-b', { approve: true });
    expect(state.order.paymentStatus).toBe('PAID');
    expect(second.recoveryRequired).toBe(true);
    expect(state.paidWrites).toBe(1);
    expect(state.jobs.map((job) => job.orderItemId).sort()).toEqual(['item-a', 'item-b']);
  });

  it('lets two administrators verify the final two suppliers without leaving the order pending', async () => {
    const { state, service } = lipaHarness({
      paymentMode: 'lipa',
      items: [live('item-a', 's-a'), live('item-b', 's-b')],
      evidence: [
        { id: 'ev-a', supplierId: 's-a', status: 'SUBMITTED' },
        { id: 'ev-b', supplierId: 's-b', status: 'SUBMITTED' },
      ],
    });
    const [first, second] = await Promise.all([
      service.reviewLipaEvidence(admin, 'ev-a', { approve: true }),
      service.reviewLipaEvidence(admin, 'ev-b', { approve: true }),
    ]);
    expect(state.order.paymentStatus).toBe('PAID');
    expect(state.paidWrites).toBe(1);
    expect([first.recoveryRequired, second.recoveryRequired]).toContain(true);
    expect(state.jobs).toHaveLength(2);
  });

  it('does not mark a COD or card order paid from Lipa evidence', async () => {
    for (const paymentMode of ['cod', 'card']) {
      const { state, service } = lipaHarness({
        paymentMode,
        items: [live('item-a', 's-a')],
        evidence: [{ id: 'ev-a', supplierId: 's-a', status: 'SUBMITTED' }],
      });
      const result = await service.reviewLipaEvidence(admin, 'ev-a', { approve: true });
      expect(state.order.paymentStatus).toBe('PENDING');
      expect(result.recoveryRequired).toBe(false);
      expect(state.jobs).toHaveLength(0);
    }
  });

  it('asks for recognition recovery when evidence is already verified and a job is unfinished', async () => {
    const { service } = lipaHarness({
      paymentMode: 'lipa',
      paymentStatus: 'PAID',
      items: [live('item-a', 's-a')],
      evidence: [{ id: 'ev-a', supplierId: 's-a', status: 'VERIFIED' }],
      jobs: [{ orderItemId: 'item-a', status: 'PENDING' }],
    });
    const result = await service.reviewLipaEvidence(admin, 'ev-a', { approve: true });
    expect(result.recoveryRequired).toBe(true);
    expect(result.evidence.status).toBe('VERIFIED');
  });

  it('rejects evidence, keeps the row, and leaves the order unpaid', async () => {
    const { state, service } = lipaHarness({
      paymentMode: 'lipa',
      items: [live('item-a', 's-a')],
      evidence: [{ id: 'ev-a', supplierId: 's-a', status: 'SUBMITTED' }],
    });
    const result = await service.reviewLipaEvidence(admin, 'ev-a', {
      approve: false,
      reviewNote: 'Not received',
    });
    expect(result.evidence.status).toBe('REJECTED');
    expect(result.evidence.reviewNote).toBe('Not received');
    expect(result.recoveryRequired).toBe(false);
    expect(state.evidence).toHaveLength(1);
    expect(state.evidence[0].status).toBe('REJECTED');
    expect(state.order.paymentStatus).toBe('PENDING');
    expect(state.jobs).toHaveLength(0);
  });
});

const kijani: AuthUser = {
  sub: 'user-kijani',
  email: 'supplier@kijani.example',
  name: 'Kijani',
  role: UserRole.SUPPLIER,
  supplierId: 's-kijani',
};

const customer: AuthUser = {
  sub: 'user-amina',
  email: 'amina.mwangi@example.com',
  name: 'Amina',
  role: UserRole.CUSTOMER,
};

function evidenceSubmitHarness(
  orders: {
    id: string;
    displayId: string;
    paymentMode: string;
    supplierIds: string[];
  }[],
) {
  const evidence: { id: string; orderId: string; supplierId: string; referenceRaw: string }[] = [];
  const prisma: any = {
    order: {
      findUnique: async ({
        where,
        include,
      }: {
        where: { id?: string; displayId?: string };
        include: { items: { where: { supplierId: string } } };
      }) => {
        const match = orders.find((row) =>
          where.id != null ? row.id === where.id : row.displayId === where.displayId,
        );
        if (!match) return null;
        const supplierId = include.items.where.supplierId;
        return {
          id: match.id,
          displayId: match.displayId,
          paymentMode: match.paymentMode,
          items: match.supplierIds
            .filter((id) => id === supplierId)
            .map((id) => ({ supplierId: id })),
        };
      },
    },
    $transaction: async (fn: (tx: any) => Promise<unknown>) =>
      fn({
        customerPaymentEvidence: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = {
              id: `ev-${evidence.length + 1}`,
              status: 'SUBMITTED',
              orderId: String(data.orderId),
              supplierId: String(data.supplierId),
              referenceRaw: String(data.referenceRaw),
            };
            evidence.push(row);
            return row;
          },
        },
        customerPaymentEvidenceOpen: {
          create: async ({ data }: { data: Record<string, unknown> }) => data,
        },
      }),
  };
  return {
    evidence,
    service: new CommissionLedgerService(
      prisma,
      { record: async () => undefined } as never,
      {} as never,
    ),
  };
}

describe('customer Lipa evidence order numbers and admin inbox', () => {
  const orders = [
    {
      id: 'order-kijani',
      displayId: 'WG-10126',
      paymentMode: 'lipa',
      supplierIds: ['s-kijani'],
    },
    {
      id: 'order-other',
      displayId: 'WG-20000',
      paymentMode: 'lipa',
      supplierIds: ['s-other'],
    },
  ];

  it('accepts the internal order id', async () => {
    const { evidence, service } = evidenceSubmitHarness(orders);
    const created = await service.submitLipaEvidence(kijani, {
      orderId: 'order-kijani',
      reference: 'TEST-CUST-LIPA-001',
    });
    expect(created.orderId).toBe('order-kijani');
    expect(created.referenceRaw).toBe('TEST-CUST-LIPA-001');
    expect(evidence).toHaveLength(1);
  });

  it('accepts the supplier-visible order number', async () => {
    const { evidence, service } = evidenceSubmitHarness(orders);
    const created = await service.submitLipaEvidence(kijani, {
      orderId: 'WG-10126',
      reference: 'TEST-CUST-LIPA-001',
    });
    expect(created.orderId).toBe('order-kijani');
    expect(evidence[0].supplierId).toBe('s-kijani');
  });

  it('refuses evidence for another supplier order', async () => {
    const { evidence, service } = evidenceSubmitHarness(orders);
    await expect(
      service.submitLipaEvidence(kijani, {
        orderId: 'WG-20000',
        reference: 'TEST-CUST-LIPA-002',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.submitLipaEvidence(kijani, {
        orderId: 'order-other',
        reference: 'TEST-CUST-LIPA-002',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(evidence).toHaveLength(0);
  });

  it('rejects an order number that does not exist', async () => {
    const { evidence, service } = evidenceSubmitHarness(orders);
    await expect(
      service.submitLipaEvidence(kijani, {
        orderId: 'WG-99999',
        reference: 'TEST-CUST-LIPA-003',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(evidence).toHaveLength(0);
  });

  it('lists pending evidence for an admin and keeps rejected evidence in the list', async () => {
    const rows = [
      {
        id: 'ev-pending',
        status: 'SUBMITTED',
        supplierId: 's-kijani',
        supplier: { name: 'Kijani Tech' },
        referenceRaw: 'TEST-CUST-LIPA-001',
        reviewNote: null,
        createdAt: new Date('2026-11-14T18:00:00.000Z'),
        order: {
          id: 'order-kijani',
          displayId: 'WG-10126',
          currency: 'USD',
          items: [
            { supplierId: 's-kijani', lineTotal: 48, status: OrderStatus.PROCESSING },
            { supplierId: 's-other', lineTotal: 10, status: OrderStatus.PROCESSING },
          ],
        },
      },
      {
        id: 'ev-rejected',
        status: 'REJECTED',
        supplierId: 's-kijani',
        supplier: { name: 'Kijani Tech' },
        referenceRaw: 'OLD-REF',
        reviewNote: 'Not received',
        createdAt: new Date('2026-11-13T18:00:00.000Z'),
        order: {
          id: 'order-old',
          displayId: 'WG-10001',
          currency: 'USD',
          items: [{ supplierId: 's-kijani', lineTotal: 20, status: OrderStatus.PROCESSING }],
        },
      },
    ];
    const prisma = { customerPaymentEvidence: { findMany: async () => rows } };
    const service = new CommissionLedgerService(
      prisma as never,
      {} as never,
      {} as never,
    );
    const listed = await service.listLipaEvidence(admin);
    expect(listed.items.map((row) => row.status)).toEqual(['SUBMITTED', 'REJECTED']);
    expect(listed.items[0]).toMatchObject({
      orderNumber: 'WG-10126',
      supplierName: 'Kijani Tech',
      amount: 48,
      currency: 'USD',
      reference: 'TEST-CUST-LIPA-001',
    });
    expect(listed.items[1].reviewNote).toBe('Not received');
  });

  it('lists only this supplier evidence, including a rejection note', async () => {
    const rows = [
      {
        id: 'ev-rejected',
        status: 'REJECTED',
        supplierId: 's-kijani',
        supplier: { name: 'Kijani Tech' },
        referenceRaw: 'TEST-CUST-LIPA-V2-002',
        reviewNote: 'Test rejection, payment not received',
        createdAt: new Date('2026-11-14T20:09:38.263Z'),
        order: {
          id: 'order-10127',
          displayId: 'WG-10127',
          currency: 'USD',
          items: [{ supplierId: 's-kijani', lineTotal: 48, status: OrderStatus.PROCESSING }],
        },
      },
      {
        id: 'ev-other',
        status: 'VERIFIED',
        supplierId: 's-other',
        supplier: { name: 'Other Shop' },
        referenceRaw: 'OTHER-REF',
        reviewNote: null,
        createdAt: new Date('2026-11-14T21:00:00.000Z'),
        order: {
          id: 'order-other',
          displayId: 'WG-20000',
          currency: 'USD',
          items: [{ supplierId: 's-other', lineTotal: 10, status: OrderStatus.PROCESSING }],
        },
      },
    ];
    const findMany = jest.fn(
      async (args: { where?: { supplierId?: string } }) =>
        rows.filter((row) => row.supplierId === args.where?.supplierId),
    );
    const service = new CommissionLedgerService(
      { customerPaymentEvidence: { findMany } } as never,
      {} as never,
      {} as never,
    );
    const listed = await service.listSupplierLipaEvidence(kijani);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { supplierId: 's-kijani' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        orderNumber: 'WG-10127',
        reference: 'TEST-CUST-LIPA-V2-002',
        status: 'REJECTED',
        reviewNote: 'Test rejection, payment not received',
        submittedAt: '2026-11-14T20:09:38.263Z',
      }),
    ]);
  });

  it('refuses the supplier evidence list to admin and customer accounts', async () => {
    const findMany = jest.fn();
    const service = new CommissionLedgerService(
      { customerPaymentEvidence: { findMany } } as never,
      {} as never,
      {} as never,
    );
    await expect(service.listSupplierLipaEvidence(admin)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listSupplierLipaEvidence(customer)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(
      new Reflector().get(ROLES_KEY, CommissionsController.prototype.supplierLipaEvidence),
    ).toEqual([UserRole.SUPPLIER]);
  });

  it('refuses the evidence list to supplier and customer accounts', async () => {
    const findMany = jest.fn();
    const service = new CommissionLedgerService(
      { customerPaymentEvidence: { findMany } } as never,
      {} as never,
      {} as never,
    );
    await expect(service.listLipaEvidence(kijani)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.listLipaEvidence(customer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
    expect(new Reflector().get(ROLES_KEY, CommissionsController.prototype.adminLipaEvidence)).toEqual([
      UserRole.ADMIN,
    ]);
  });

  it('verifies and rejects through the existing admin actions', async () => {
    const ledger = {
      reviewLipaEvidence: jest.fn(async (_user: AuthUser, id: string, body: { approve: boolean; reviewNote?: string }) => ({
        evidence: {
          id,
          status: body.approve ? 'VERIFIED' : 'REJECTED',
          reviewNote: body.reviewNote ?? null,
        },
        orderId: 'order-kijani',
        recoveryRequired: false,
      })),
    };
    const recognition = { run: jest.fn() };
    const controller = new CommissionsController({} as never, ledger as never, recognition as never);
    const verified = await controller.verifyLipaEvidence(admin, 'ev-pending');
    const rejected = await controller.rejectLipaEvidence(admin, 'ev-other', {
      reviewNote: 'Not received',
    });
    expect(verified.status).toBe('VERIFIED');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.reviewNote).toBe('Not received');
    expect(recognition.run).not.toHaveBeenCalled();
    expect(ledger.reviewLipaEvidence).toHaveBeenNthCalledWith(2, admin, 'ev-other', {
      approve: false,
      reviewNote: 'Not received',
    });
  });
});

function snapshot(input: {
  id: string;
  supplierId: string;
  amount: number;
  settleableAt: string;
  status?: string;
  itemStatus?: string;
  isDemo?: boolean;
  paymentMode?: string;
}) {
  return {
    id: input.id,
    isDemo: input.isDemo ?? false,
    status: input.status ?? 'SETTLEABLE',
    paymentMode: input.paymentMode ?? 'lipa',
    commissionAmount: input.amount,
    settleableAt: new Date(input.settleableAt),
    orderItem: {
      supplierId: input.supplierId,
      status: input.itemStatus ?? OrderStatus.DELIVERED,
      order: {
        paymentStatus: 'PAID',
        paymentMode: input.paymentMode ?? 'lipa',
        cashCollections: [],
      },
    },
    cashAllocations: [] as {
      amountUsd: number;
      reversals: { amountUsd: number }[];
      remittance: { status: string };
    }[],
    creditApplications: [] as { id: string; sources: { amountUsd: number; reversals: { amountUsd: number }[] }[] }[],
  };
}

function sweepHarness(options: {
  remittances: { id: string; supplierId: string; amount: number; verifiedAt: string }[];
  snapshots: ReturnType<typeof snapshot>[];
  credits?: {
    id: string;
    supplierId: string;
    amount: number;
    sourceId: string;
  }[];
}) {
  const state = {
    remittances: options.remittances.map((row) => ({
      id: row.id,
      supplierId: row.supplierId,
      status: 'VERIFIED',
      autoApply: true,
      verifiedAmountUsd: row.amount,
      verifiedAt: new Date(row.verifiedAt),
      allocations: [] as { amountUsd: number; reversals: { amountUsd: number }[] }[],
    })),
    snapshots: options.snapshots,
    credits: (options.credits ?? []).map((row) => ({
      id: row.id,
      supplierId: row.supplierId,
      amountUsd: row.amount,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      offsets: [] as { amountUsd: number }[],
      applications: [] as {
        id: string;
        sources: { amountUsd: number; reversals: { amountUsd: number }[] }[];
      }[],
      sources: [
        {
          id: row.sourceId,
          amountUsd: row.amount,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          applicationSources: [] as { amountUsd: number; reversals: { amountUsd: number }[]; createdAt: Date }[],
          offsetSources: [] as { amountUsd: number }[],
        },
      ],
    })),
    allocations: [] as { remittanceId: string; orderItemCommissionId: string; amountUsd: number }[],
    applications: [] as { id: string; amountUsd: number; creditId: string; orderItemCommissionId: string }[],
    events: [] as { systemActorKey: string; action: string; entityId: string }[],
  };
  const audit = { record: jest.fn() };
  let tail: Promise<void> = Promise.resolve();
  const prisma: any = {
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx: any = {
        commissionRemittance: {
          findMany: async ({ where }: { where: { supplierId: string; status: string; autoApply: boolean } }) =>
            state.remittances
              .filter(
                (row) =>
                  row.supplierId === where.supplierId &&
                  row.status === where.status &&
                  row.autoApply === where.autoApply,
              )
              .map((row) => ({ ...row, verifiedAt: new Date(row.verifiedAt), allocations: [...row.allocations] })),
          findUnique: async ({ where }: { where: { id: string } }) => {
            const row = state.remittances.find((item) => item.id === where.id);
            if (!row) return null;
            return {
              ...row,
              verifiedAt: new Date(row.verifiedAt),
              allocations: row.allocations.map((allocation) => ({ ...allocation, reversals: [] })),
            };
          },
        },
        commissionCredit: {
          findMany: async ({ where }: { where: { supplierId: string } }) =>
            state.credits
              .filter((row) => row.supplierId === where.supplierId)
              .map((row) => ({
                ...row,
                createdAt: new Date(row.createdAt),
                offsets: [...row.offsets],
                applications: row.applications.map((application) => ({
                  ...application,
                  sources: application.sources.map((source) => ({
                    ...source,
                    reversals: [...source.reversals],
                  })),
                })),
                sources: row.sources.map((source) => ({
                  ...source,
                  createdAt: new Date(source.createdAt),
                  offsetSources: [...source.offsetSources],
                  applicationSources: source.applicationSources.map((application) => ({
                    ...application,
                    createdAt: new Date(application.createdAt),
                    reversals: [...(application.reversals ?? [])],
                  })),
                })),
              })),
        },
        orderItemCommission: {
          findMany: async ({ where }: { where: any }) =>
            state.snapshots
              .filter((row) => {
                if (where.isDemo === false && row.isDemo) return false;
                if (where.status && row.status !== where.status) return false;
                if (where.paymentMode?.in && !where.paymentMode.in.includes(row.paymentMode)) return false;
                if (where.orderItem?.supplierId && row.orderItem.supplierId !== where.orderItem.supplierId) {
                  return false;
                }
                if (where.orderItem?.status && row.orderItem.status !== where.orderItem.status) return false;
                return true;
              })
              .map((row) => ({
                ...row,
                settleableAt: new Date(row.settleableAt),
                orderItem: {
                  ...row.orderItem,
                  order: { ...row.orderItem.order, cashCollections: [] },
                },
                cashAllocations: row.cashAllocations.map((allocation) => ({
                  ...allocation,
                  reversals: [...allocation.reversals],
                  remittance: { ...allocation.remittance },
                })),
                creditApplications: row.creditApplications.map((application) => ({
                  ...application,
                  sources: application.sources.map((source) => ({
                    ...source,
                    reversals: [...source.reversals],
                  })),
                })),
              })),
        },
        commissionAllocation: {
          create: async ({ data }: { data: any }) => {
            const row = {
              id: `alloc-${state.allocations.length + 1}`,
              remittanceId: data.remittanceId,
              orderItemCommissionId: data.orderItemCommissionId,
              amountUsd: Number(data.amountUsd),
              actorType: data.actorType,
              systemActorKey: data.systemActorKey,
            };
            state.allocations.push(row);
            const remittance = state.remittances.find((item) => item.id === data.remittanceId);
            remittance?.allocations.push({ amountUsd: row.amountUsd, reversals: [] });
            const line = state.snapshots.find((item) => item.id === data.orderItemCommissionId);
            line?.cashAllocations.push({
              amountUsd: row.amountUsd,
              reversals: [],
              remittance: { status: 'VERIFIED' },
            });
            return row;
          },
        },
        commissionCreditApplication: {
          create: async ({ data }: { data: any }) => {
            const row = {
              id: `app-${state.applications.length + 1}`,
              creditId: data.creditId,
              amountUsd: Number(data.amountUsd),
              orderItemCommissionId: data.orderItemCommissionId,
            };
            state.applications.push(row);
            const credit = state.credits.find((item) => item.id === data.creditId);
            credit?.applications.push({ id: row.id, sources: [] });
            return row;
          },
        },
        commissionCreditApplicationSource: {
          create: async ({ data }: { data: any }) => {
            const amountUsd = Number(data.amountUsd);
            const credit = state.credits.find((item) =>
              item.sources.some((source) => source.id === data.creditSourceId),
            );
            const source = credit?.sources.find((item) => item.id === data.creditSourceId);
            source?.applicationSources.push({
              amountUsd,
              reversals: [],
              createdAt: new Date(),
            });
            const application = credit?.applications.find((item) => item.id === data.applicationId);
            application?.sources.push({ amountUsd, reversals: [] });
            const stored = state.applications.find((item) => item.id === data.applicationId);
            const line = state.snapshots.find((item) => item.id === stored?.orderItemCommissionId);
            let bucket = line?.creditApplications.find((item) => item.id === data.applicationId);
            if (line && !bucket) {
              bucket = { id: data.applicationId, sources: [] };
              line.creditApplications.push(bucket);
            }
            bucket?.sources.push({ amountUsd, reversals: [] });
            return { ...data, amountUsd };
          },
        },
        commissionSystemEvent: {
          create: async ({ data }: { data: any }) => {
            state.events.push(data);
            return data;
          },
        },
      };
      tx.$executeRaw = async () => 0;
      tx.$queryRaw = async () => {
        if (!tx.held) {
          const previous = tail;
          let release = () => {};
          tail = new Promise<void>((resolve) => {
            release = resolve;
          });
          tx.release = release;
          tx.held = true;
          await previous;
        }
        return [{ id: 'locked' }];
      };
      try {
        return await fn(tx);
      } finally {
        tx.release?.();
      }
    },
  };
  return {
    state,
    audit,
    service: new CommissionLedgerService(prisma, audit as never, {} as never),
  };
}

describe('automatic sweep locking', () => {
  const lines = () => [
    snapshot({ id: 'snap-old', supplierId: 's-a', amount: 10, settleableAt: '2026-01-01T00:00:00.000Z' }),
    snapshot({ id: 'snap-new', supplierId: 's-a', amount: 10, settleableAt: '2026-02-01T00:00:00.000Z' }),
    snapshot({ id: 'snap-b', supplierId: 's-b', amount: 30, settleableAt: '2026-01-01T00:00:00.000Z' }),
    snapshot({
      id: 'snap-demo',
      supplierId: 's-a',
      amount: 50,
      settleableAt: '2026-01-01T00:00:00.000Z',
      isDemo: true,
    }),
    snapshot({
      id: 'snap-pending',
      supplierId: 's-a',
      amount: 50,
      settleableAt: '2026-01-01T00:00:00.000Z',
      status: 'PENDING',
    }),
    snapshot({
      id: 'snap-open',
      supplierId: 's-a',
      amount: 50,
      settleableAt: '2026-01-01T00:00:00.000Z',
      itemStatus: OrderStatus.PROCESSING,
    }),
  ];

  it('does not allocate the same remittance twice, including across overlapping sweeps', async () => {
    const { state, audit, service } = sweepHarness({
      remittances: [
        { id: 'rem-a', supplierId: 's-a', amount: 15, verifiedAt: '2026-03-01T00:00:00.000Z' },
        { id: 'rem-b', supplierId: 's-b', amount: 30, verifiedAt: '2026-03-01T00:00:00.000Z' },
      ],
      snapshots: lines(),
    });
    await Promise.all([service.sweepSupplier('s-a'), service.sweepSupplier('s-a')]);
    const total = state.allocations.reduce((sum, row) => sum + row.amountUsd, 0);
    expect(total).toBe(15);
    expect(state.allocations.map((row) => [row.orderItemCommissionId, row.amountUsd])).toEqual([
      ['snap-old', 10],
      ['snap-new', 5],
    ]);
    expect(state.allocations.some((row) => row.remittanceId === 'rem-b')).toBe(false);
    expect(state.events.every((event) => event.systemActorKey === 'commission-sweep')).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
    await service.sweepSupplier('s-a');
    expect(state.allocations.reduce((sum, row) => sum + row.amountUsd, 0)).toBe(15);
  });

  it('does not consume the same credit twice across overlapping sweeps', async () => {
    const { state, service } = sweepHarness({
      remittances: [],
      snapshots: [
        snapshot({ id: 'snap-a', supplierId: 's-a', amount: 20, settleableAt: '2026-01-01T00:00:00.000Z' }),
      ],
      credits: [{ id: 'credit-1', supplierId: 's-a', amount: 8, sourceId: 'source-1' }],
    });
    await Promise.all([service.sweepSupplier('s-a'), service.sweepSupplier('s-a')]);
    const applied = state.applications.reduce((sum, row) => sum + row.amountUsd, 0);
    expect(applied).toBe(8);
    expect(state.applications).toHaveLength(1);
    await service.sweepSupplier('s-a');
    expect(state.applications.reduce((sum, row) => sum + row.amountUsd, 0)).toBe(8);
    expect(state.events[0].action).toBe('COMMISSION_CREDIT_APPLIED');
    expect(state.events[0].systemActorKey).toBe('commission-sweep');
  });
});

describe('recognition recovery', () => {
  function recoveryFor(
    jobs: { id: string; orderId: string; orderItemId: string; supplierId: string; status: string }[],
    advance: (orderItemId: string) => Promise<{ status: string } | null>,
  ) {
    const ledger = {
      recognitionJobs: jest.fn(async (orderId?: string) =>
        jobs.filter(
          (job) =>
            (!orderId || job.orderId === orderId) &&
            (job.status === CommissionRecognitionJobStatus.PENDING ||
              job.status === CommissionRecognitionJobStatus.AWAITING_SWEEP),
        ),
      ),
      setRecognitionJobStatus: jest.fn(async (id: string, status: string) => {
        const job = jobs.find((row) => row.id === id);
        if (job) job.status = status;
      }),
      sweepSupplier: jest.fn(async () => undefined),
    };
    const commissions = { advanceRecognitionForItem: jest.fn(advance) };
    const recovery = new CommissionRecognitionRecovery(commissions as never, ledger as never);
    return { jobs, ledger, commissions, recovery };
  }

  it('finishes recognition after the order is paid and does not duplicate it on retry', async () => {
    const harness = recoveryFor(
      [
        {
          id: 'job-1',
          orderId: 'order-1',
          orderItemId: 'item-1',
          supplierId: 's-a',
          status: CommissionRecognitionJobStatus.PENDING,
        },
      ],
      async () => ({ status: CommissionRecognitionStatus.SETTLEABLE }),
    );
    const first = await harness.recovery.recover(admin, 'order-1');
    expect(first.sweptSuppliers).toEqual(['s-a']);
    expect(harness.commissions.advanceRecognitionForItem).toHaveBeenCalledTimes(1);
    const second = await harness.recovery.recover(admin, 'order-1');
    expect(second.processed).toBe(0);
    expect(harness.commissions.advanceRecognitionForItem).toHaveBeenCalledTimes(1);
    expect(harness.ledger.sweepSupplier).toHaveBeenCalledTimes(1);
  });

  it('sweeps a delivered line and leaves an undelivered line recognised', async () => {
    const harness = recoveryFor(
      [
        {
          id: 'job-delivered',
          orderId: 'order-1',
          orderItemId: 'item-delivered',
          supplierId: 's-a',
          status: CommissionRecognitionJobStatus.PENDING,
        },
        {
          id: 'job-open',
          orderId: 'order-1',
          orderItemId: 'item-open',
          supplierId: 's-b',
          status: CommissionRecognitionJobStatus.PENDING,
        },
      ],
      async (orderItemId) => ({
        status:
          orderItemId === 'item-delivered'
            ? CommissionRecognitionStatus.SETTLEABLE
            : CommissionRecognitionStatus.RECOGNIZED,
      }),
    );
    const result = await harness.recovery.run('order-1');
    expect(result.sweptSuppliers).toEqual(['s-a']);
    expect(harness.ledger.sweepSupplier).not.toHaveBeenCalledWith('s-b');
  });

  it('sweeps every supplier whose own line became payable and nobody else', async () => {
    const harness = recoveryFor(
      [
        {
          id: 'job-a',
          orderId: 'order-1',
          orderItemId: 'item-a',
          supplierId: 's-a',
          status: CommissionRecognitionJobStatus.PENDING,
        },
        {
          id: 'job-b',
          orderId: 'order-1',
          orderItemId: 'item-b',
          supplierId: 's-b',
          status: CommissionRecognitionJobStatus.PENDING,
        },
      ],
      async () => ({ status: CommissionRecognitionStatus.SETTLEABLE }),
    );
    const result = await harness.recovery.run('order-1');
    expect(result.sweptSuppliers).toEqual(['s-a', 's-b']);
    expect(harness.ledger.sweepSupplier).toHaveBeenCalledTimes(2);
  });

  it('retries a sweep that was left unfinished without recognising the line again', async () => {
    const harness = recoveryFor(
      [
        {
          id: 'job-1',
          orderId: 'order-1',
          orderItemId: 'item-1',
          supplierId: 's-a',
          status: CommissionRecognitionJobStatus.AWAITING_SWEEP,
        },
      ],
      async () => ({ status: CommissionRecognitionStatus.SETTLEABLE }),
    );
    await harness.recovery.run('order-1');
    expect(harness.commissions.advanceRecognitionForItem).not.toHaveBeenCalled();
    expect(harness.ledger.sweepSupplier).toHaveBeenCalledWith('s-a');
    expect(harness.jobs[0].status).toBe(CommissionRecognitionJobStatus.COMPLETED);
  });

  it('does not sweep when evidence approval has not made the order payable', async () => {
    const ledger = {
      reviewLipaEvidence: jest.fn(async () => ({
        evidence: { id: 'ev-a' },
        orderId: 'order-1',
        recoveryRequired: false,
      })),
    };
    const recognition = { run: jest.fn(), recover: jest.fn() };
    const controller = new CommissionsController({} as never, ledger as never, recognition as never);
    await controller.verifyLipaEvidence(admin, 'ev-a');
    expect(recognition.run).not.toHaveBeenCalled();
  });

  it('requires one order id before recovery can run', async () => {
    const ledger = { assertOrderRecoveryScope: jest.fn() };
    const recognition = { recover: jest.fn(async () => ({ processed: 0, sweptSuppliers: [] })) };
    const controller = new CommissionsController({} as never, ledger as never, recognition as never);
    await expect(controller.recoverRecognition(admin, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.recoverRecognition(admin, { orderId: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.recoverRecognition(admin, { orderId: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.recoverRecognition(admin, { orderId: 'bad id' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.recoverRecognition(admin, { orderId: '../order-1' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(controller.recoverRecognition(admin, { orderId: 12345 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ledger.assertOrderRecoveryScope).not.toHaveBeenCalled();
    expect(recognition.recover).not.toHaveBeenCalled();

    ledger.assertOrderRecoveryScope.mockResolvedValue(undefined);
    await controller.recoverRecognition(admin, {
      orderId: ' order-1234 ',
      supplierId: 'supplier-1',
    });
    expect(ledger.assertOrderRecoveryScope).toHaveBeenCalledWith('order-1234', 'supplier-1');
    expect(recognition.recover).toHaveBeenCalledWith(admin, 'order-1234');
  });

  it('refuses recovery that does not name an order', async () => {
    const ledger = { recognitionJobs: jest.fn() };
    const recovery = new CommissionRecognitionRecovery({} as never, ledger as never);
    await expect(recovery.run('')).rejects.toBeInstanceOf(BadRequestException);
    await expect(recovery.run('bad id')).rejects.toBeInstanceOf(BadRequestException);
    expect(ledger.recognitionJobs).not.toHaveBeenCalled();
  });
});

describe('provider event idempotency', () => {
  it('does not reverse a remittance twice for the same provider event', async () => {
    const state = {
      reversals: [] as { id: string; remittanceId: string }[],
      events: [] as { eventId: string; remittanceReversalId: string; remittanceReversal?: { id: string; remittanceId: string } }[],
    };
    const tx = {
      $executeRaw: async () => 0,
      $queryRaw: async () => [{ id: 'locked' }],
      commissionRemittance: {
        findUnique: async ({ select }: { select?: { supplierId: boolean } }) => {
          if (select?.supplierId) return { supplierId: 's-a' };
          return {
            id: 'rem-1',
            supplierId: 's-a',
            status: 'VERIFIED',
            verifiedAmountUsd: 10,
            referenceNormalized: 'ABC',
            allocations: [],
          };
        },
        update: async () => ({ id: 'rem-1' }),
      },
      commissionProviderEvent: {
        findUnique: async ({ where }: { where: { eventId: string } }) =>
          state.events.find((event) => event.eventId === where.eventId) ?? null,
        create: async ({ data }: { data: { eventId: string; remittanceReversalId: string } }) => {
          const reversal = state.reversals.find((row) => row.id === data.remittanceReversalId);
          const event = { ...data, remittanceReversal: reversal };
          state.events.push(event);
          return event;
        },
      },
      commissionRemittanceReversal: {
        findUnique: async ({ where }: { where: { remittanceId: string } }) =>
          state.reversals.find((row) => row.remittanceId === where.remittanceId) ?? null,
        create: async ({ data }: { data: { remittanceId: string } }) => {
          const row = { id: 'rev-1', ...data };
          state.reversals.push(row);
          return row;
        },
      },
    };
    const service = new CommissionLedgerService(
      { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never,
      { record: async () => undefined } as never,
      {} as never,
    );
    const first = await service.reverseRemittance(admin, 'rem-1', {
      reason: 'bank returned it',
      providerEventId: 'evt-1',
    });
    const second = await service.reverseRemittance(admin, 'rem-1', {
      reason: 'bank returned it',
      providerEventId: 'evt-1',
    });
    expect(first.id).toBe(second.id);
    expect(state.reversals).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    await expect(
      service.reverseRemittance(admin, 'rem-2', {
        reason: 'bank returned it',
        providerEventId: 'evt-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(state.reversals).toHaveLength(1);
  });
});

describe('allocation activity for administrators', () => {
  it('exposes a system sweep without presenting it as a human user', () => {
    const allocation = toAdminAllocation({
      id: 'alloc-1',
      remittanceId: 'rem-1',
      orderItemCommissionId: 'snap-1',
      amountUsd: 12.5,
      reason: 'SWEEP',
      actorType: CommissionActorType.SYSTEM,
      systemActorKey: 'commission-sweep',
      actorUserId: 'commission-sweep',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      remittance: { supplierId: 's-a' },
      orderItemCommission: { orderItemId: 'item-1' },
    });
    expect(allocation).toMatchObject({
      id: 'alloc-1',
      remittanceId: 'rem-1',
      supplierId: 's-a',
      orderItemId: 'item-1',
      amountUsd: 12.5,
      reason: 'SWEEP',
      actorType: CommissionActorType.SYSTEM,
      systemActor: 'commission-sweep',
      actorUserId: null,
      createdAt: '2026-04-01T00:00:00.000Z',
    });
    const application = toAdminCreditApplication({
      id: 'app-1',
      creditId: 'credit-1',
      orderItemCommissionId: 'snap-1',
      amountUsd: 8,
      reason: 'AUTO',
      actorType: CommissionActorType.SYSTEM,
      systemActorKey: 'commission-sweep',
      actorUserId: 'commission-sweep',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      credit: { supplierId: 's-a' },
      orderItemCommission: { orderItemId: 'item-1' },
      sources: [
        { creditSourceId: 'source-1', amountUsd: 8, reversals: [{ amountUsd: 3 }] },
      ],
    });
    expect(application.actorUserId).toBeNull();
    expect(application.sources[0].activeAmountUsd).toBe(5);
  });

  it('refuses a supplier recovery call', async () => {
    const recovery = new CommissionRecognitionRecovery(
      { advanceRecognitionForItem: jest.fn() } as never,
      {} as never,
    );
    await expect(
      recovery.recover(
        { ...admin, role: UserRole.SUPPLIER, supplierId: 's-a' },
        'order-1',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
