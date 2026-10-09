import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Used only when the rate table is empty. A live feed replaces these. */
const DEV_QUOTES: Record<string, number> = {
  USD: 1,
  TZS: 2650,
  KES: 129,
  EUR: 0.92,
};

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const FX_FEED_URL = 'https://open.er-api.com/v6/latest';
const AUTO_SOURCE = 'exchangerate-api';

export type FxQuote = {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  source: string;
  fetchedAt: string;
  expiresAt: string;
  fresh: boolean;
};

@Injectable()
export class FxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FxService.name);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<number> | null = null;
  /** Live 1-base-unit quotes. Tests replace this. */
  fetchLiveRates = fetchOpenExchangeRates;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureSettings();
    await this.seedDevRatesIfEmpty();
    await this.refreshStaleRates();
    this.refreshTimer = setInterval(() => {
      void this.refreshStaleRates();
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  normalize(code?: string | null): string {
    return (code ?? '').trim().toUpperCase();
  }

  async ensureSettings() {
    return this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default' },
      update: {},
    });
  }

  async publicConfig() {
    const settings = await this.ensureSettings();
    const settlement = this.normalize(settings.currency) || 'USD';
    return {
      settlementCurrency: settlement,
      supportedDisplayCurrencies: this.readCodes(
        settings.supportedDisplayCurrencies,
        ['USD', 'TZS', 'KES', 'EUR'],
      ),
      supportedPaymentCurrencies: this.readCodes(
        settings.supportedPaymentCurrencies,
        ['USD', 'TZS'],
      ),
      fxMaxAgeSeconds: settings.fxMaxAgeSeconds,
      stripeConfigured: this.stripeCheckoutMode() !== 'demo',
      stripeCheckoutMode: this.stripeCheckoutMode(),
      stripePublishableKey: this.stripePublishableKey(),
    };
  }

  /** demo until a Stripe secret key is set. Publishable keys are not enough to charge. */
  stripeCheckoutMode(): 'demo' | 'test' | 'live' {
    const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
    if (secret.startsWith('sk_live_')) return 'live';
    if (secret.startsWith('sk_test_')) return 'test';
    return 'demo';
  }

  stripePublishableKey(): string | null {
    const key = process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? '';
    if (key.startsWith('pk_test_') || key.startsWith('pk_live_')) return key;
    return null;
  }

  async quote(base: string, quote: string): Promise<FxQuote> {
    const baseCurrency = this.normalize(base);
    const quoteCurrency = this.normalize(quote);
    if (!baseCurrency || !quoteCurrency) {
      throw new BadRequestException('Currency code is required');
    }
    if (baseCurrency === quoteCurrency) {
      const now = new Date();
      return {
        baseCurrency,
        quoteCurrency,
        rate: 1,
        source: 'identity',
        fetchedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 365 * 86400000).toISOString(),
        fresh: true,
      };
    }

    let row = await this.prisma.exchangeRate.findUnique({
      where: {
        baseCurrency_quoteCurrency: { baseCurrency, quoteCurrency },
      },
    });
    if (this.rateNeedsRefresh(row)) {
      await this.refreshStaleRates();
      row = await this.prisma.exchangeRate.findUnique({
        where: {
          baseCurrency_quoteCurrency: { baseCurrency, quoteCurrency },
        },
      });
    }
    if (!row) {
      throw new BadRequestException(
        `No exchange rate for ${baseCurrency} to ${quoteCurrency}`,
      );
    }
    const fresh = row.expiresAt.getTime() > Date.now();
    if (!fresh) {
      throw new BadRequestException(
        `Exchange rate ${baseCurrency}/${quoteCurrency} expired at ${row.expiresAt.toISOString()}. Refresh rates before converting.`,
      );
    }
    return {
      baseCurrency,
      quoteCurrency,
      rate: Number(row.rate),
      source: row.source,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      fresh: true,
    };
  }

  convert(amount: number, rate: number): number {
    return roundMoney(amount * rate);
  }

  async assertDisplayCurrency(code: string) {
    const config = await this.publicConfig();
    const normalized = this.normalize(code);
    if (!config.supportedDisplayCurrencies.includes(normalized)) {
      throw new BadRequestException(
        `${normalized} is not a supported display currency`,
      );
    }
    return normalized;
  }

  async resolvePaymentCurrency(displayCurrency: string, settlement: string) {
    const config = await this.publicConfig();
    const display = this.normalize(displayCurrency);
    const pay = config.supportedPaymentCurrencies.includes(display)
      ? display
      : this.normalize(settlement);
    if (!config.supportedPaymentCurrencies.includes(pay)) {
      throw new BadRequestException(
        `Payment currency ${pay} is not supported by the configured provider`,
      );
    }
    return pay;
  }

  async setDisplayCurrency(userId: string, code: string | null) {
    const displayCurrency = code ? await this.assertDisplayCurrency(code) : null;
    await this.prisma.user.update({
      where: { id: userId },
      data: { displayCurrency },
    });
    return { displayCurrency };
  }

  async updateSettings(
    user: AuthUser,
    body: {
      settlementCurrency?: string;
      supportedDisplayCurrencies?: string[];
      supportedPaymentCurrencies?: string[];
      fxMaxAgeSeconds?: number;
    },
  ) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can configure currencies');
    }
    const current = await this.publicConfig();
    const settlement = body.settlementCurrency
      ? this.normalize(body.settlementCurrency)
      : current.settlementCurrency;
    const display = (body.supportedDisplayCurrencies ?? current.supportedDisplayCurrencies)
      .map((c) => this.normalize(c))
      .filter(Boolean);
    const payment = (body.supportedPaymentCurrencies ?? current.supportedPaymentCurrencies)
      .map((c) => this.normalize(c))
      .filter(Boolean);
    if (!/^[A-Z]{3}$/.test(settlement)) {
      throw new BadRequestException('settlementCurrency must be ISO 4217');
    }
    if (!display.includes(settlement)) {
      display.unshift(settlement);
    }
    for (const code of payment) {
      if (!display.includes(code)) {
        throw new BadRequestException(
          `Payment currency ${code} must also be a display currency`,
        );
      }
    }
    if (!payment.includes(settlement)) {
      throw new BadRequestException(
        'Settlement currency must be a supported payment currency',
      );
    }
    const fxMaxAgeSeconds =
      body.fxMaxAgeSeconds != null
        ? Math.floor(body.fxMaxAgeSeconds)
        : current.fxMaxAgeSeconds;
    if (fxMaxAgeSeconds < 60) {
      throw new BadRequestException('fxMaxAgeSeconds must be at least 60');
    }
    await this.prisma.platformSettings.update({
      where: { id: 'default' },
      data: {
        currency: settlement,
        supportedDisplayCurrencies: display,
        supportedPaymentCurrencies: payment,
        fxMaxAgeSeconds,
      },
    });
    return this.publicConfig();
  }

  async upsertRate(
    user: AuthUser,
    body: { baseCurrency?: string; quoteCurrency?: string; rate?: number; source?: string },
  ) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can set exchange rates');
    }
    const settings = await this.ensureSettings();
    const baseCurrency = this.normalize(body.baseCurrency || settings.currency);
    const quoteCurrency = this.normalize(body.quoteCurrency);
    const rate = Number(body.rate);
    if (!/^[A-Z]{3}$/.test(quoteCurrency) || !Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException('quoteCurrency and positive rate are required');
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.fxMaxAgeSeconds * 1000);
    const row = await this.prisma.exchangeRate.upsert({
      where: {
        baseCurrency_quoteCurrency: { baseCurrency, quoteCurrency },
      },
      create: {
        baseCurrency,
        quoteCurrency,
        rate: new Prisma.Decimal(rate.toFixed(8)),
        source: body.source?.trim() || 'manual',
        fetchedAt: now,
        expiresAt,
      },
      update: {
        rate: new Prisma.Decimal(rate.toFixed(8)),
        source: body.source?.trim() || 'manual',
        fetchedAt: now,
        expiresAt,
      },
    });
    return {
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: Number(row.rate),
      source: row.source,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      fresh: true,
    };
  }

  /**
   * Replace rates that expired, or that are still the first-boot seed.
   * A rate saved by an admin stays until its lifetime ends.
   */
  async refreshStaleRates(): Promise<number> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.refreshStaleRatesOnce().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async listRates() {
    await this.refreshStaleRates();
    const rows = await this.prisma.exchangeRate.findMany({
      orderBy: [{ baseCurrency: 'asc' }, { quoteCurrency: 'asc' }],
    });
    const now = Date.now();
    return rows.map((row) => ({
      baseCurrency: row.baseCurrency,
      quoteCurrency: row.quoteCurrency,
      rate: Number(row.rate),
      source: row.source,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      fresh: row.expiresAt.getTime() > now,
    }));
  }

  private async seedDevRatesIfEmpty() {
    const count = await this.prisma.exchangeRate.count();
    if (count > 0) return;
    const settings = await this.ensureSettings();
    const base = this.normalize(settings.currency) || 'USD';
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.fxMaxAgeSeconds * 1000);
    for (const [quote, rate] of Object.entries(DEV_QUOTES)) {
      if (quote === base) continue;
      await this.prisma.exchangeRate.create({
        data: {
          baseCurrency: base,
          quoteCurrency: quote,
          rate: new Prisma.Decimal(rate.toFixed(8)),
          source: 'dev-seed',
          fetchedAt: now,
          expiresAt,
        },
      });
    }
  }

  private rateNeedsRefresh(
    row: { source: string; expiresAt: Date } | null | undefined,
  ): boolean {
    if (!row) return true;
    if (row.expiresAt.getTime() <= Date.now()) return true;
    return row.source === 'dev-seed';
  }

  private async refreshStaleRatesOnce(): Promise<number> {
    const settings = await this.ensureSettings();
    const base = this.normalize(settings.currency) || 'USD';
    const wanted = this.readCodes(settings.supportedDisplayCurrencies, [
      'USD',
      'TZS',
      'KES',
      'EUR',
    ]).filter((code) => code !== base);
    if (!wanted.length) return 0;

    const rows = await this.prisma.exchangeRate.findMany({
      where: { baseCurrency: base, quoteCurrency: { in: wanted } },
    });
    const byQuote = new Map(rows.map((row) => [row.quoteCurrency, row]));
    const stale = wanted.filter((code) => this.rateNeedsRefresh(byQuote.get(code)));
    if (!stale.length) return 0;

    let live: Record<string, number>;
    try {
      live = await this.fetchLiveRates(base, stale);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Exchange rate refresh failed: ${message}`);
      return 0;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.fxMaxAgeSeconds * 1000);
    let updated = 0;
    for (const quoteCurrency of stale) {
      const rate = live[quoteCurrency];
      if (!Number.isFinite(rate) || rate <= 0) {
        this.logger.warn(`No live rate for ${base}/${quoteCurrency}`);
        continue;
      }
      await this.prisma.exchangeRate.upsert({
        where: {
          baseCurrency_quoteCurrency: { baseCurrency: base, quoteCurrency },
        },
        create: {
          baseCurrency: base,
          quoteCurrency,
          rate: new Prisma.Decimal(rate.toFixed(8)),
          source: AUTO_SOURCE,
          fetchedAt: now,
          expiresAt,
        },
        update: {
          rate: new Prisma.Decimal(rate.toFixed(8)),
          source: AUTO_SOURCE,
          fetchedAt: now,
          expiresAt,
        },
      });
      updated += 1;
    }
    if (updated > 0) {
      this.logger.log(`Refreshed ${updated} exchange rate(s) for ${base}`);
    }
    return updated;
  }

  private readCodes(value: unknown, fallback: string[]): string[] {
    if (Array.isArray(value)) {
      const codes = value
        .map((item) => this.normalize(String(item)))
        .filter((code) => /^[A-Z]{3}$/.test(code));
      if (codes.length) return [...new Set(codes)];
    }
    return fallback;
  }
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 1 base unit in each requested quote currency. No API key. */
export async function fetchOpenExchangeRates(
  base: string,
  quotes: string[],
): Promise<Record<string, number>> {
  const root = (process.env.FX_FEED_URL?.trim() || FX_FEED_URL).replace(/\/$/, '');
  const response = await fetch(`${root}/${encodeURIComponent(base)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`FX feed HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    result?: string;
    rates?: Record<string, number>;
  };
  if (body.result && body.result !== 'success') {
    throw new Error('FX feed rejected the request');
  }
  const rates = body.rates ?? {};
  const out: Record<string, number> = {};
  for (const quote of quotes) {
    const rate = Number(rates[quote]);
    if (Number.isFinite(rate) && rate > 0) out[quote] = rate;
  }
  return out;
}
