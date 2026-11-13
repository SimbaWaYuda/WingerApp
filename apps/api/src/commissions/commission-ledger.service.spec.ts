import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CommissionLedgerService } from './commission-ledger.service';

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
