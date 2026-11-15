import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CommissionLedgerService } from './commission-ledger.service';

function admin() {
  return {
    sub: 'admin-1',
    email: 'admin@winger.example',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

describe('CommissionLedgerService guards', () => {
  const service = new CommissionLedgerService(
    {} as never,
    { record: jest.fn() } as never,
    {} as never,
  );
  const supplier = {
    sub: 'user-1',
    email: 'supplier@winger.example',
    name: 'Supplier',
    role: UserRole.SUPPLIER,
    supplierId: 's-1',
  };

  it('refuses a supplier verification', async () => {
    await expect(service.verifyRemittance(supplier, 'rem-1', {})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses a supplier reversal', async () => {
    await expect(
      service.reverseRemittance(supplier, 'rem-1', { reason: 'bank returned it' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a blank payment reference', async () => {
    await expect(
      service.submitRemittance(supplier, {
        method: 'WINGER_LIPA' as never,
        claimedAmount: 10,
        claimedCurrency: 'USD',
        reference: '   ',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an administrator receipt without a provider or account', async () => {
    const admin = { ...supplier, role: UserRole.ADMIN, supplierId: undefined };
    await expect(
      service.recordAdminReceipt(admin, {
        supplierId: 's-1',
        method: 'ADMIN_RECORDED' as never,
        claimedAmount: 10,
        claimedCurrency: 'USD',
        reference: 'REF1',
        provider: '',
        merchantAccountKey: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('applyReturnClawback', () => {
  it('turns $1 of a $6 allocation into a credit and restores the $4 credit', async () => {
    const state = halfSettledState();
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
    );
    const result = await service.applyReturnClawback(fakeTx(state) as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: false, applied: true });
    expect(state.allocationReversals).toEqual([
      expect.objectContaining({ allocationId: 'alloc-6', amountUsd: '1.00' }),
    ]);
    expect(state.applicationReversals).toEqual([
      expect.objectContaining({ applicationSourceId: 'app-source-4', amountUsd: '4.00' }),
    ]);
    expect(state.credits).toEqual([
      expect.objectContaining({
        amountUsd: '1.00',
        sourceEventKey: 'return-clawback:ret-half',
      }),
    ]);
    expect(state.credits[0].sources).toEqual([
      { allocationId: 'alloc-6', amountUsd: '1.00' },
    ]);
    expect(state.clawback.appliedAt).toBeInstanceOf(Date);
    expect(state.snapshot.status).toBe('SETTLEABLE');
    expect(6 - Number(state.allocationReversals[0].amountUsd)).toBe(5);
  });

  it('does not create a cash credit when the commission is unpaid', async () => {
    const state = halfSettledState();
    state.snapshot.cashAllocations = [];
    state.snapshot.creditApplications = [];
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
    );
    await service.applyReturnClawback(fakeTx(state) as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(state.credits).toEqual([]);
    expect(state.allocationReversals).toEqual([]);
    expect(state.applicationReversals).toEqual([]);
  });

  it('does nothing the second time the same refund is applied', async () => {
    const state = halfSettledState();
    state.clawback.appliedAt = new Date('2026-11-14T00:00:00Z');
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const result = await service.applyReturnClawback(fakeTx(state) as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: false, applied: false });
    expect(state.credits).toEqual([]);
  });
});

function halfSettledState() {
  const clawback = {
    id: 'claw-1',
    returnRequestId: 'ret-half',
    orderItemCommissionId: 'snap-1',
    commissionAmount: 5,
    quantity: 1,
    appliedAt: null as Date | null,
  };
  const snapshot = {
    id: 'snap-1',
    commissionAmount: 10,
    status: 'SETTLEABLE',
    orderItem: { supplierId: 'sup-1' },
    clawbacks: [clawback],
    cashAllocations: [
      {
        id: 'alloc-6',
        amountUsd: 6,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        reversals: [] as { amountUsd: number }[],
        remittance: { status: 'VERIFIED' },
      },
    ],
    creditApplications: [
      {
        sources: [
          {
            id: 'app-source-4',
            amountUsd: 4,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            reversals: [] as { amountUsd: number }[],
          },
        ],
      },
    ],
  };
  return {
    clawback,
    snapshot,
    allocationReversals: [] as { allocationId: string; amountUsd: string }[],
    applicationReversals: [] as { applicationSourceId: string; amountUsd: string }[],
    credits: [] as {
      amountUsd: string;
      sourceEventKey: string;
      sources: { allocationId: string; amountUsd: string }[];
    }[],
  };
}

function fakeTx(state: ReturnType<typeof halfSettledState>) {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commissionClawback: {
      findUnique: jest.fn(async () => state.clawback),
      update: jest.fn(async ({ data }: { data: { appliedAt: Date } }) => {
        state.clawback.appliedAt = data.appliedAt;
        return state.clawback;
      }),
    },
    orderItemCommission: {
      findUnique: jest.fn(async () => state.snapshot),
      update: jest.fn(async ({ data }: { data: { status: string } }) => {
        state.snapshot.status = data.status;
        return state.snapshot;
      }),
    },
    commissionAllocationReversal: {
      create: jest.fn(async ({ data }: { data: { allocationId: string; amountUsd: { toFixed(n: number): string } } }) => {
        state.allocationReversals.push({
          allocationId: data.allocationId,
          amountUsd: data.amountUsd.toFixed(2),
        });
      }),
    },
    commissionCreditApplicationSourceReversal: {
      create: jest.fn(async ({ data }: { data: { applicationSourceId: string; amountUsd: { toFixed(n: number): string } } }) => {
        state.applicationReversals.push({
          applicationSourceId: data.applicationSourceId,
          amountUsd: data.amountUsd.toFixed(2),
        });
      }),
    },
    commissionCredit: {
      create: jest.fn(async ({ data }: { data: { amountUsd: { toFixed(n: number): string }; sourceEventKey: string; sources: { create: { allocationId: string; amountUsd: { toFixed(n: number): string } }[] } } }) => {
        state.credits.push({
          amountUsd: data.amountUsd.toFixed(2),
          sourceEventKey: data.sourceEventKey,
          sources: data.sources.create.map((source) => ({
            allocationId: source.allocationId,
            amountUsd: source.amountUsd.toFixed(2),
          })),
        });
      }),
    },
  };
}
