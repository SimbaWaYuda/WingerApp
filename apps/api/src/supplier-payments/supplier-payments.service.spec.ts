import { ForbiddenException } from '@nestjs/common';
import {
  PaymentArrangementPreference,
  SupplierPaymentProfileStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { SupplierPaymentsService } from './supplier-payments.service';

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    sub: 'u-supplier',
    email: 's@example.com',
    role: UserRole.SUPPLIER,
    supplierId: 'sup-1',
    name: 'Supplier',
    ...overrides,
  };
}

describe('SupplierPaymentsService', () => {
  const prisma: any = {
    supplierPaymentProfile: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    supplier: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(prisma)),
  };
  const audit = { record: jest.fn() };
  let service: SupplierPaymentsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SupplierPaymentsService(prisma as never, audit as never);
    prisma.supplier.findUnique.mockResolvedValue({
      id: 'sup-1',
      name: 'Dr Winga',
      verificationStatus: 'APPROVED',
    });
  });

  it('rejects customer role from supplier endpoints', async () => {
    await expect(
      service.getMine(user({ role: UserRole.CUSTOMER, supplierId: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects admin mutations from supplier preference helper path', async () => {
    await expect(
      service.listPending(user()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('submits a pending profile for review', async () => {
    prisma.supplierPaymentProfile.findFirst
      .mockResolvedValueOnce(null) // approved
      .mockResolvedValueOnce(null) // pending
      .mockResolvedValueOnce(null); // latest version
    prisma.supplierPaymentProfile.create.mockResolvedValue({
      id: 'p1',
      supplierId: 'sup-1',
      preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
      network: 'ALL_NETWORKS',
      merchantName: 'Dr Winga Fashion',
      lipaOrTillNumber: 'TILL123456',
      status: SupplierPaymentProfileStatus.PENDING_REVIEW,
      version: 1,
    });
    prisma.supplierPaymentProfile.findMany.mockResolvedValue([
      {
        id: 'p1',
        supplierId: 'sup-1',
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        network: 'ALL_NETWORKS',
        merchantName: 'Dr Winga Fashion',
        lipaOrTillNumber: 'TILL123456',
        status: SupplierPaymentProfileStatus.PENDING_REVIEW,
        version: 1,
      },
    ]);

    const result = await service.submitMine(user(), {
      preference: 'SUPPLIER_DIRECT',
      merchantName: 'Dr Winga Fashion',
      lipaOrTillNumber: 'till 123456',
    });

    expect(prisma.supplierPaymentProfile.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lipaOrTillNumber: 'TILL123456',
          status: SupplierPaymentProfileStatus.PENDING_REVIEW,
          preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        }),
      }),
    );
    expect(result.effectiveArrangement).toBe(
      PaymentArrangementPreference.WINGER_MANAGED,
    );
    expect(result.pendingProfile?.id).toBe('p1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUBMITTED' }),
    );
  });

  it('approves pending and supersedes prior approved', async () => {
    const pending = {
      id: 'p2',
      supplierId: 'sup-1',
      preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
      network: 'M_PESA',
      merchantName: 'Dr Winga Fashion',
      lipaOrTillNumber: 'TILL999999',
      status: SupplierPaymentProfileStatus.PENDING_REVIEW,
      version: 2,
      replacesProfileId: 'p1',
    };
    prisma.supplierPaymentProfile.findUnique.mockResolvedValue(pending);
    prisma.supplierPaymentProfile.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...pending,
        ...data,
      }),
    );
    prisma.supplierPaymentProfile.findMany.mockResolvedValue([
      {
        ...pending,
        status: SupplierPaymentProfileStatus.APPROVED,
        activeFrom: new Date(),
      },
    ]);

    const admin = user({
      sub: 'u-admin',
      role: UserRole.ADMIN,
      supplierId: null,
      email: 'a@example.com',
      name: 'Admin',
    });
    const result = await service.approve(admin, 'p2');

    expect(prisma.supplierPaymentProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: { status: SupplierPaymentProfileStatus.SUPERSEDED },
      }),
    );
    expect(result.effectiveArrangement).toBe(
      PaymentArrangementPreference.SUPPLIER_DIRECT,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'APPROVED' }),
    );
  });

  it('hides customer instructions unless approved direct', () => {
    expect(
      service.customerVisibleInstructions({
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        status: SupplierPaymentProfileStatus.PENDING_REVIEW,
        merchantName: 'X',
        lipaOrTillNumber: 'TILL123456',
        network: 'ALL_NETWORKS' as never,
      }),
    ).toBeNull();
    expect(
      service.customerVisibleInstructions({
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
        status: SupplierPaymentProfileStatus.APPROVED,
        merchantName: 'X',
        lipaOrTillNumber: 'TILL123456',
        network: 'ALL_NETWORKS' as never,
      }),
    ).toEqual({
      merchantName: 'X',
      lipaOrTillNumber: 'TILL123456',
      network: 'ALL_NETWORKS',
    });
  });
});
