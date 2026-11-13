import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ExecutionContext } from '@nestjs/common';
import {
  ApprovedSupplierGuard,
  supplierMayOperate,
} from './approved-supplier.guard';
import { AuthUser } from './auth.types';

function contextFor(user?: AuthUser): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as ExecutionContext;
}

describe('supplierMayOperate', () => {
  it('allows approved and verified suppliers', () => {
    expect(supplierMayOperate('APPROVED')).toBe(true);
    expect(supplierMayOperate('VERIFIED')).toBe(true);
  });

  it('blocks pending and unknown statuses', () => {
    expect(supplierMayOperate('UNVERIFIED')).toBe(false);
    expect(supplierMayOperate('SUBMITTED')).toBe(false);
    expect(supplierMayOperate(null)).toBe(false);
  });
});

describe('ApprovedSupplierGuard', () => {
  const prisma = {
    supplier: { findUnique: jest.fn() },
  };
  const guard = new ApprovedSupplierGuard(prisma as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('allows requests with no supplier role', async () => {
    await expect(guard.canActivate(contextFor())).resolves.toBe(true);
    await expect(
      guard.canActivate(
        contextFor({
          sub: 'c1',
          email: 'a@example.com',
          name: 'Amina',
          role: UserRole.CUSTOMER,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(
        contextFor({
          sub: 'admin',
          email: 'admin@winger.example',
          name: 'Admin',
          role: UserRole.ADMIN,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('allows an approved supplier', async () => {
    prisma.supplier.findUnique.mockResolvedValue({
      verificationStatus: 'APPROVED',
    });
    await expect(
      guard.canActivate(
        contextFor({
          sub: 's1',
          email: 'supplier@kijani.example',
          name: 'Kijani',
          role: UserRole.SUPPLIER,
          supplierId: 's-kijani',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('blocks a supplier who is not approved', async () => {
    prisma.supplier.findUnique.mockResolvedValue({
      verificationStatus: 'SUBMITTED',
    });
    await expect(
      guard.canActivate(
        contextFor({
          sub: 's2',
          email: 'new@supplier.example',
          name: 'New',
          role: UserRole.SUPPLIER,
          supplierId: 's-new',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
