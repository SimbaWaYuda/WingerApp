import { BadRequestException } from '@nestjs/common';
import { FxService, roundMoney } from './fx.service';

describe('FxService.quote', () => {
  const now = new Date();
  const prisma = {
    platformSettings: {
      upsert: jest.fn().mockResolvedValue({
        currency: 'USD',
        supportedDisplayCurrencies: ['USD', 'TZS'],
        supportedPaymentCurrencies: ['USD'],
        fxMaxAgeSeconds: 86400,
      }),
    },
    exchangeRate: {
      count: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  };
  const fx = new FxService(prisma as any);

  it('converts with a fresh rate and refuses an expired one', async () => {
    prisma.exchangeRate.findUnique.mockResolvedValueOnce({
      baseCurrency: 'USD',
      quoteCurrency: 'TZS',
      rate: 2650,
      source: 'dev-seed',
      fetchedAt: now,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const quote = await fx.quote('usd', 'tzs');
    expect(quote.rate).toBe(2650);
    expect(roundMoney(10 * quote.rate)).toBe(26500);

    prisma.exchangeRate.findUnique.mockResolvedValueOnce({
      baseCurrency: 'USD',
      quoteCurrency: 'TZS',
      rate: 2000,
      source: 'dev-seed',
      fetchedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(fx.quote('USD', 'TZS')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('pays in the display currency when that currency is payable', async () => {
    prisma.platformSettings.upsert.mockResolvedValueOnce({
      currency: 'USD',
      supportedDisplayCurrencies: ['USD', 'TZS', 'KES'],
      supportedPaymentCurrencies: ['USD', 'TZS'],
      fxMaxAgeSeconds: 86400,
    });
    await expect(fx.resolvePaymentCurrency('tzs', 'USD')).resolves.toBe('TZS');

    prisma.platformSettings.upsert.mockResolvedValueOnce({
      currency: 'USD',
      supportedDisplayCurrencies: ['USD', 'TZS', 'KES'],
      supportedPaymentCurrencies: ['USD', 'TZS'],
      fxMaxAgeSeconds: 86400,
    });
    await expect(fx.resolvePaymentCurrency('KES', 'USD')).resolves.toBe('USD');
  });

  it('uses identity rate when currencies match', async () => {
    const quote = await fx.quote('USD', 'USD');
    expect(quote.rate).toBe(1);
    expect(quote.fresh).toBe(true);
  });
});
