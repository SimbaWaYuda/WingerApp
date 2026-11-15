import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CommissionRecognitionStatus, UserRole } from '@prisma/client';
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
    const tx = fakeTx(state);
    const result = await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: false, applied: true });
    expect(lockSequence(tx)).toEqual([
      'oic-nku',
      'supplier-advisory',
      'credit-rows',
      'credit-sources',
    ]);
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
    const tx = fakeTx(state);
    await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(lockSequence(tx)).toEqual([
      'oic-nku',
      'supplier-advisory',
      'credit-rows',
      'credit-sources',
    ]);
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
    const tx = fakeTx(state);
    const result = await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: false, applied: false });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(state.credits).toEqual([]);
  });

  it('reads the OIC snapshot only after acquiring locks', async () => {
    const state = halfSettledState();
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn().mockResolvedValue({}) } as never,
      {} as never,
    );
    const tx = fakeTx(state);
    const order: string[] = [];
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      order.push(classifyLockSql(strings));
      if (classifyLockSql(strings) === 'oic-nku') {
        return [
          {
            id: state.snapshot.id,
            supplierId: state.snapshot.orderItem.supplierId,
          },
        ];
      }
      return [];
    });
    tx.$executeRaw.mockImplementation((...args: unknown[]) => {
      order.push(classifyLockSql(args[0] as TemplateStringsArray));
      return Promise.resolve(0);
    });
    tx.orderItemCommission.findUnique = jest.fn(async () => {
      order.push('snapshot-read');
      return state.snapshot;
    });
    await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-half',
      actor: admin(),
    });
    expect(order).toEqual([
      'oic-nku',
      'supplier-advisory',
      'credit-rows',
      'credit-sources',
      'snapshot-read',
    ]);
    expect(tx.orderItemCommission.findUnique).toHaveBeenCalledTimes(1);
  });

  it('locks OIC before returning legacy when no reservation exists', async () => {
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const $queryRaw = jest.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
        { id: 'snap-1', supplierId: 'sup-1' },
      ],
    );
    const tx = {
      $queryRaw,
      $executeRaw: jest.fn(),
      commissionClawback: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(),
      },
      orderItemCommission: {
        findUnique: jest.fn(),
      },
    };
    const result = await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-none',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: true, applied: false });
    expect($queryRaw).toHaveBeenCalled();
    expect(classifyLockSql($queryRaw.mock.calls[0][0])).toBe('oic-nku');
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.orderItemCommission.findUnique).not.toHaveBeenCalled();
  });

  it('returns legacy without locking when no OIC exists for the return', async () => {
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const tx = {
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(),
      commissionClawback: {
        findUnique: jest.fn(async () => null),
      },
    };
    const result = await service.applyReturnClawback(tx as never, {
      returnRequestId: 'ret-no-oic',
      actor: admin(),
    });
    expect(result).toEqual({ legacy: true, applied: false });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('reserveReturnClawback', () => {
  it('returns the existing reservation without locking when present', async () => {
    const existing = {
      id: 'claw-existing',
      returnRequestId: 'ret-1',
      commissionAmount: 5,
    };
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const tx = {
      $queryRaw: jest.fn(),
      commissionClawback: {
        findUnique: jest.fn(async () => existing),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };
    const result = await service.reserveReturnClawback(tx as never, {
      orderItemId: 'item-1',
      returnRequestId: 'ret-1',
      quantity: 1,
      unitPrice: 50,
      lineQuantity: 2,
    });
    expect(result).toBe(existing);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.commissionClawback.create).not.toHaveBeenCalled();
  });

  it('locks OIC then recalculates the slice from post-lock clawbacks', async () => {
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const created = { id: 'claw-new' };
    const prior = [
      {
        id: 'claw-prior',
        quantity: 1,
        commissionAmount: 5,
      },
    ];
    let findUniqueCalls = 0;
    const $queryRaw = jest.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
        {
          id: 'snap-1',
          status: CommissionRecognitionStatus.SETTLEABLE,
          commissionAmount: 10,
        },
      ],
    );
    const tx = {
      $queryRaw,
      commissionClawback: {
        findUnique: jest.fn(async () => {
          findUniqueCalls += 1;
          return null;
        }),
        findMany: jest.fn(async () => prior),
        create: jest.fn(async ({ data }: { data: { commissionAmount: { toFixed(n: number): string } } }) => {
          expect(data.commissionAmount.toFixed(2)).toBe('5.00');
          return created;
        }),
      },
    };
    const result = await service.reserveReturnClawback(tx as never, {
      orderItemId: 'item-1',
      returnRequestId: 'ret-2',
      quantity: 1,
      unitPrice: 50,
      lineQuantity: 2,
    });
    expect(result).toBe(created);
    expect(findUniqueCalls).toBe(2);
    expect($queryRaw).toHaveBeenCalled();
    expect(classifyLockSql($queryRaw.mock.calls[0][0])).toBe('oic-nku');
    expect(tx.commissionClawback.findMany).toHaveBeenCalledWith({
      where: { orderItemCommissionId: 'snap-1' },
    });
  });

  it('refuses a new reservation when the OIC is already CLAWED_BACK', async () => {
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    const tx = {
      $queryRaw: jest.fn(async () => [
        {
          id: 'snap-1',
          status: CommissionRecognitionStatus.CLAWED_BACK,
          commissionAmount: 10,
        },
      ]),
      commissionClawback: {
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };
    await expect(
      service.reserveReturnClawback(tx as never, {
        orderItemId: 'item-1',
        returnRequestId: 'ret-late',
        quantity: 1,
        unitPrice: 100,
        lineQuantity: 1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.commissionClawback.create).not.toHaveBeenCalled();
  });

  it('returns the reservation discovered after the OIC lock', async () => {
    const raced = { id: 'claw-raced', returnRequestId: 'ret-race' };
    const service = new CommissionLedgerService(
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
    );
    let finds = 0;
    const tx = {
      $queryRaw: jest.fn(async () => [
        {
          id: 'snap-1',
          status: CommissionRecognitionStatus.SETTLEABLE,
          commissionAmount: 10,
        },
      ]),
      commissionClawback: {
        findUnique: jest.fn(async () => {
          finds += 1;
          return finds === 1 ? null : raced;
        }),
        findMany: jest.fn(),
        create: jest.fn(),
      },
    };
    const result = await service.reserveReturnClawback(tx as never, {
      orderItemId: 'item-1',
      returnRequestId: 'ret-race',
      quantity: 1,
      unitPrice: 100,
      lineQuantity: 1,
    });
    expect(result).toBe(raced);
    expect(tx.commissionClawback.create).not.toHaveBeenCalled();
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

function classifyLockSql(strings: TemplateStringsArray | string): string {
  const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (sql.includes('OrderItemCommission') && sql.includes('FOR NO KEY UPDATE')) {
    return 'oic-nku';
  }
  if (sql.includes('pg_advisory_xact_lock') && sql.includes('hashtextextended')) {
    return 'supplier-advisory';
  }
  if (sql.includes('CommissionCreditSource')) {
    return 'credit-sources';
  }
  if (sql.includes('CommissionCredit') && sql.includes('FOR UPDATE')) {
    return 'credit-rows';
  }
  return 'other';
}

function lockSequence(tx: {
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
}) {
  const events: { order: number; kind: string }[] = [];
  tx.$queryRaw.mock.invocationCallOrder.forEach((order, index) => {
    events.push({
      order,
      kind: classifyLockSql(tx.$queryRaw.mock.calls[index][0]),
    });
  });
  tx.$executeRaw.mock.invocationCallOrder.forEach((order, index) => {
    events.push({
      order,
      kind: classifyLockSql(tx.$executeRaw.mock.calls[index][0]),
    });
  });
  return events.sort((a, b) => a.order - b.order).map((row) => row.kind);
}

function fakeTx(state: ReturnType<typeof halfSettledState>) {
  return {
    $executeRaw: jest.fn(async () => 0),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const kind = classifyLockSql(strings);
      if (kind === 'oic-nku') {
        return [
          {
            id: state.snapshot.id,
            supplierId: state.snapshot.orderItem.supplierId,
          },
        ];
      }
      return [];
    }),
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
