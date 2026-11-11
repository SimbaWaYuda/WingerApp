import { BadRequestException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { StripeService } from './stripe.service';

describe('PayoutsService reverseIfTransferred', () => {
  it('is a no-op when the line was never transferred', async () => {
    const prisma = {
      orderItemCommission: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'snap-1',
          stripeTransferId: null,
          transferReversed: false,
        }),
        update: jest.fn(),
      },
    };
    const stripe = {
      connectTestReady: () => true,
      reverseSupplierTransfer: jest.fn(),
    };
    const service = new PayoutsService(prisma as never, stripe as unknown as StripeService);

    await service.reverseIfTransferred('item-1');

    expect(stripe.reverseSupplierTransfer).not.toHaveBeenCalled();
  });

  it('throws when Stripe cannot reverse an existing transfer', async () => {
    const prisma = {
      orderItemCommission: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'snap-1',
          stripeTransferId: 'tr_1',
          transferReversed: false,
        }),
        update: jest.fn(),
      },
    };
    const stripe = {
      connectTestReady: () => true,
      reverseSupplierTransfer: jest.fn().mockRejectedValue(new Error('balance insufficient')),
    };
    const service = new PayoutsService(prisma as never, stripe as unknown as StripeService);

    await expect(service.reverseIfTransferred('item-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
  });
});
