import { CommissionAllocationReason, UserRole } from '@prisma/client';
import { CommissionLedgerService } from './commission-ledger.service';

type Allocation = {
  id: string;
  amountUsd: number;
  reversals: { amountUsd: number }[];
  creditSources: { amountUsd: number; offsetSources: { amountUsd: number }[] }[];
};

function allocation(id: string, amount: number): Allocation {
  return { id, amountUsd: amount, reversals: [], creditSources: [] };
}

function openLine() {
  return {
    id: 'snap-open',
    isDemo: false,
    status: 'SETTLEABLE',
    paymentMode: 'cod',
    commissionAmount: 20,
    settleableAt: new Date('2026-11-01T00:00:00Z'),
    clawbacks: [],
    orderItem: {
      supplierId: 'sup-b',
      status: 'DELIVERED',
      order: { paymentStatus: 'PAID', paymentMode: 'cod', cashCollections: [] },
    },
    cashAllocations: [],
    creditApplications: [],
  };
}

describe('allocation lifecycle after a cash credit', () => {
  function harness(input: {
    snapshot: {
      id: string;
      orderItem?: { supplierId: string };
      cashAllocations: Allocation[];
      creditApplications: { sources: { id: string; amountUsd: number; reversals: [] }[] }[];
    };
    remittances: {
      id: string;
      supplierId: string;
      verifiedAmountUsd: number;
      allocations: Allocation[];
    }[];
  }) {
    const created: { remittanceId: string; amountUsd: string }[] = [];
    const credits: { sourceEventKey: string }[] = [];
    const tx = {
      $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn(async () => []),
      orderItemCommission: {
        findUnique: jest.fn(async () => ({
          ...input.snapshot,
          orderItem: input.snapshot.orderItem ?? { supplierId: 'sup-b' },
        })),
        findMany: jest.fn(async () => [openLine()]),
      },
      commissionAllocationReversal: {
        findUnique: jest.fn(async ({ where }: { where: { reversalKey: string } }) =>
          input.snapshot.cashAllocations
            .flatMap((row) => row.reversals)
            .find((row) => (row as { reversalKey?: string }).reversalKey === where.reversalKey) ??
          null,
        ),
        create: jest.fn(async ({ data }: { data: { allocationId: string; amountUsd: { toString(): string }; reversalKey: string } }) => {
          const row = input.snapshot.cashAllocations.find((allocation) => allocation.id === data.allocationId);
          row?.reversals.push({
            amountUsd: Number(data.amountUsd),
            reversalKey: data.reversalKey,
          } as Allocation['reversals'][number]);
          return data;
        }),
      },
      commissionCreditApplicationSourceReversal: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: unknown }) => data),
      },
      commissionCredit: {
        findUnique: jest.fn(async ({ where }: { where: { sourceEventKey: string } }) =>
          credits.find((row) => row.sourceEventKey === where.sourceEventKey) ?? null,
        ),
        create: jest.fn(async ({ data }: { data: { sourceEventKey: string; amountUsd: { toString(): string }; sources: { create: { allocationId: string; amountUsd: { toString(): string } }[] } } }) => {
          credits.push({ sourceEventKey: data.sourceEventKey });
          for (const source of data.sources.create) {
            const row = input.snapshot.cashAllocations.find(
              (allocation) => allocation.id === source.allocationId,
            );
            row?.creditSources.push({
              amountUsd: Number(source.amountUsd),
              offsetSources: [],
            });
          }
          return data;
        }),
      },
      commissionRemittance: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          input.remittances.find((row) => row.id === where.id) ?? null,
        ),
      },
      commissionSystemEvent: { create: jest.fn(async () => ({})) },
      commissionAllocation: {
        create: jest.fn(async ({ data }: { data: { remittanceId: string; amountUsd: { toString(): string } } }) => {
          created.push({
            remittanceId: data.remittanceId,
            amountUsd: Number(data.amountUsd).toFixed(2),
          });
          return { id: `new-${created.length}` };
        }),
      },
    };
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
    );
    return { service, tx, created };
  }

  async function sweep(
    harnessed: ReturnType<typeof harness>,
    remittanceId: string,
  ) {
    await (
      harnessed.service as unknown as {
        allocateRemittanceCash: (
          tx: unknown,
          id: string,
          actor: unknown,
          reason: CommissionAllocationReason,
        ) => Promise<void>;
      }
    ).allocateRemittanceCash(
      harnessed.tx,
      remittanceId,
      { userId: 'commission-sweep', systemKey: 'commission-sweep' },
      CommissionAllocationReason.SWEEP,
    );
  }

  it('reverses the allocation, opens the matching credit, and will not sweep that cash again', async () => {
    const cash = allocation('alloc-3', 3);
    const state = harness({
      snapshot: {
        id: 'snap-b',
        orderItem: { supplierId: 'sup-b' },
        cashAllocations: [cash],
        creditApplications: [
          { sources: [{ id: 'app-source-2', amountUsd: 2, reversals: [] }] },
        ],
      },
      remittances: [
        { id: 'rem-b', supplierId: 'sup-b', verifiedAmountUsd: 3, allocations: [cash] },
        { id: 'rem-other', supplierId: 'sup-b', verifiedAmountUsd: 10, allocations: [] },
      ],
    });
    const actor = {
      sub: 'admin-1',
      email: 'admin@winger.example',
      name: 'Admin',
      role: UserRole.ADMIN,
    };
    await state.service.restoreAfterClawback(state.tx as never, 'snap-b', actor);
    await state.service.restoreAfterClawback(state.tx as never, 'snap-b', actor);
    expect(cash.reversals).toEqual([
      expect.objectContaining({ amountUsd: 3 }),
    ]);
    expect(cash.creditSources).toEqual([
      expect.objectContaining({ amountUsd: 3 }),
    ]);
    expect(state.tx.commissionCredit.create).toHaveBeenCalledTimes(1);
    await sweep(state, 'rem-b');
    await sweep(state, 'rem-other');
    expect(state.created).toEqual([{ remittanceId: 'rem-other', amountUsd: '10.00' }]);
  });

  it('keeps a partial-return reversal out of the next sweep and leaves another remittance free', async () => {
    const cash = allocation('alloc-6', 6);
    cash.reversals.push({ amountUsd: 1 });
    cash.creditSources.push({ amountUsd: 1, offsetSources: [] });
    const unrelated = allocation('alloc-fresh', 4);
    const state = harness({
      snapshot: { id: 'unused', cashAllocations: [], creditApplications: [] },
      remittances: [
        { id: 'rem-partial', supplierId: 'sup-b', verifiedAmountUsd: 6, allocations: [cash] },
        { id: 'rem-fresh', supplierId: 'sup-b', verifiedAmountUsd: 8, allocations: [unrelated] },
      ],
    });
    await sweep(state, 'rem-partial');
    await sweep(state, 'rem-fresh');
    expect(state.created).toEqual([{ remittanceId: 'rem-fresh', amountUsd: '4.00' }]);
  });
});
