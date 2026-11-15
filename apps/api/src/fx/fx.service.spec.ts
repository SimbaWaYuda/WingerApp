import { BadRequestException, Logger } from '@nestjs/common';
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
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn(),
      create: jest.fn(),
    },
  };
  const fx = new FxService(prisma as any);

  it('converts with a fresh saved rate and refuses an expired one when refresh fails', async () => {
    fx.fetchLiveRates = jest.fn().mockRejectedValue(new Error('offline'));
    prisma.exchangeRate.findUnique.mockResolvedValueOnce({
      baseCurrency: 'USD',
      quoteCurrency: 'TZS',
      rate: 2650,
      source: 'manual',
      fetchedAt: now,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const quote = await fx.quote('usd', 'tzs');
    expect(quote.rate).toBe(2650);
    expect(roundMoney(10 * quote.rate)).toBe(26500);
    expect(fx.fetchLiveRates).not.toHaveBeenCalled();

    const expired = {
      baseCurrency: 'USD',
      quoteCurrency: 'TZS',
      rate: 2000,
      source: 'exchangerate-api',
      fetchedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    };
    prisma.exchangeRate.findUnique.mockResolvedValueOnce(expired);
    prisma.exchangeRate.findUnique.mockResolvedValueOnce(expired);
    prisma.exchangeRate.findMany.mockResolvedValueOnce([expired]);
    await expect(fx.quote('USD', 'TZS')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('replaces an expired rate with a live rate', async () => {
    const expired = {
      baseCurrency: 'USD',
      quoteCurrency: 'TZS',
      rate: 2000,
      source: 'exchangerate-api',
      fetchedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    };
    const saved = {
      ...expired,
      rate: 2618.547243,
      fetchedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    prisma.exchangeRate.findUnique.mockResolvedValueOnce(expired);
    prisma.exchangeRate.findUnique.mockResolvedValueOnce(saved);
    prisma.exchangeRate.findMany.mockResolvedValueOnce([expired]);
    prisma.exchangeRate.upsert.mockResolvedValueOnce(saved);
    fx.fetchLiveRates = jest.fn().mockResolvedValue({ TZS: 2618.547243 });

    const quote = await fx.quote('USD', 'TZS');
    expect(quote.rate).toBe(2618.547243);
    expect(quote.source).toBe('exchangerate-api');
    expect(prisma.exchangeRate.upsert).toHaveBeenCalled();
  });

  it('keeps a saved rate until it expires', async () => {
    prisma.exchangeRate.findMany.mockResolvedValueOnce([
      {
        baseCurrency: 'USD',
        quoteCurrency: 'TZS',
        source: 'manual',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    fx.fetchLiveRates = jest.fn();
    await expect(fx.refreshStaleRates()).resolves.toBe(0);
    expect(fx.fetchLiveRates).not.toHaveBeenCalled();
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

  it('logs a rejected scheduled refresh and does not leave it unhandled', async () => {
    jest.useFakeTimers();
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const settings = {
      currency: 'USD',
      supportedDisplayCurrencies: ['USD', 'TZS'],
      supportedPaymentCurrencies: ['USD'],
      fxMaxAgeSeconds: 86400,
    };
    const scheduledPrisma = {
      platformSettings: {
        upsert: jest.fn().mockResolvedValue(settings),
      },
      exchangeRate: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            baseCurrency: 'USD',
            quoteCurrency: 'TZS',
            source: 'manual',
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        ]),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        create: jest.fn(),
      },
    };
    const scheduled = new FxService(scheduledPrisma as any);

    try {
      await scheduled.onModuleInit();
      const readsAfterStartup = scheduledPrisma.exchangeRate.findMany.mock.calls.length;
      expect(readsAfterStartup).toBe(1);

      scheduledPrisma.platformSettings.upsert.mockRejectedValueOnce(
        new Error("Can't reach database server at `localhost:5433`"),
      );
      await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

      expect(warn).toHaveBeenCalledWith(
        "Scheduled exchange rate refresh failed: Can't reach database server at `localhost:5433`",
      );
      expect(unhandled).toEqual([]);

      await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(scheduledPrisma.exchangeRate.findMany.mock.calls.length).toBeGreaterThan(
        readsAfterStartup,
      );
    } finally {
      scheduled.onModuleDestroy();
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
      jest.useRealTimers();
    }
  });
});
