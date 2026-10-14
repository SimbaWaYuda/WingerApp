import { randomBytes } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CommissionRecognitionStatus, Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { supplierTransferForBalance } from './supplier-payout.math';
import { StripeService } from './stripe.service';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async status(user: AuthUser) {
    const supplier = await this.requireSupplier(user);
    if (supplier.stripeAccountId && this.stripe.connectTestReady()) {
      await this.syncAccount(supplier.id, supplier.stripeAccountId);
    }
    const fresh = await this.prisma.supplier.findUniqueOrThrow({
      where: { id: supplier.id },
    });
    return {
      testModeOnly: true,
      connectReady: this.stripe.connectTestReady(),
      payoutsEnabled: fresh.stripePayoutsEnabled,
      hasAccount: !!fresh.stripeAccountId,
    };
  }

  async startOnboarding(user: AuthUser) {
    if (!this.stripe.connectTestReady()) {
      throw new BadRequestException('Stripe payouts stay in test mode.');
    }
    const supplier = await this.requireSupplier(user);
    const state = supplier.stripeConnectState ?? randomBytes(24).toString('hex');
    let accountId = supplier.stripeAccountId;
    try {
      if (!accountId) {
        const created = await this.stripe.createExpressAccount({
          email: user.email,
          supplierId: supplier.id,
        });
        accountId = created.id;
      }
      await this.prisma.supplier.update({
        where: { id: supplier.id },
        data: { stripeAccountId: accountId, stripeConnectState: state },
      });
      const origin = publicApiOrigin();
      const link = await this.stripe.createAccountLink({
        accountId,
        refreshUrl: `${origin}/payments/connect/refresh?state=${state}`,
        returnUrl: `${origin}/payments/connect/return?state=${state}`,
      });
      return { url: link.url };
    } catch (error) {
      throw new BadRequestException(safeStripeMessage(error));
    }
  }

  async syncByState(state: string) {
    const supplier = await this.findByState(state);
    if (!supplier?.stripeAccountId || !this.stripe.connectTestReady()) return;
    await this.syncAccount(supplier.id, supplier.stripeAccountId);
  }

  async refreshLink(state: string): Promise<string> {
    const supplier = await this.findByState(state);
    if (!supplier?.stripeAccountId) {
      throw new NotFoundException('Payout setup was not found');
    }
    if (!this.stripe.connectTestReady()) {
      throw new BadRequestException('Stripe payouts stay in test mode.');
    }
    const origin = publicApiOrigin();
    const link = await this.stripe.createAccountLink({
      accountId: supplier.stripeAccountId,
      refreshUrl: `${origin}/payments/connect/refresh?state=${state}`,
      returnUrl: `${origin}/payments/connect/return?state=${state}`,
    });
    return link.url;
  }

  async transferSettleableForSupplier(user: AuthUser) {
    const supplier = await this.requireSupplier(user);
    const rows = await this.prisma.orderItemCommission.findMany({
      where: {
        status: CommissionRecognitionStatus.SETTLEABLE,
        isDemo: false,
        stripeTransferId: null,
        orderItem: { supplierId: supplier.id },
      },
      select: { orderItemId: true },
    });
    const results = [];
    for (const row of rows) {
      results.push(await this.transferIfSettleable(row.orderItemId));
    }
    const skipped: Record<string, number> = {};
    for (const row of results) {
      if (row.transferred) continue;
      skipped[row.reason] = (skipped[row.reason] ?? 0) + 1;
    }
    return {
      attempted: results.length,
      transferred: results.filter((row) => row.transferred).length,
      skipped,
    };
  }

  async transferIfSettleable(orderItemId: string): Promise<{
    transferred: boolean;
    reason: string;
  }> {
    try {
      const item = await this.prisma.orderItem.findUnique({
        where: { id: orderItemId },
        include: {
          commission: true,
          order: true,
          supplier: true,
        },
      });
      const snap = item?.commission;
      if (!item || !snap) return { transferred: false, reason: 'no_commission' };
      if (snap.status !== CommissionRecognitionStatus.SETTLEABLE) {
        return { transferred: false, reason: 'not_settleable' };
      }
      if (snap.isDemo || snap.paymentMode === 'demo') {
        return { transferred: false, reason: 'demo' };
      }
      if (snap.stripeTransferId) return { transferred: false, reason: 'already_transferred' };
      if (item.order.paymentMode === 'cod' || !item.order.stripePaymentIntentId) {
        return { transferred: false, reason: 'no_card_charge' };
      }
      if (!item.supplier.stripeAccountId || !item.supplier.stripePayoutsEnabled) {
        return { transferred: false, reason: 'supplier_not_connected' };
      }
      if (!this.stripe.connectTestReady()) {
        return { transferred: false, reason: 'test_mode_only' };
      }
      const balance = await this.stripe.chargeBalanceForPaymentIntent(
        item.order.stripePaymentIntentId,
      );
      if (!balance) return { transferred: false, reason: 'no_charge' };
      const quote = supplierTransferForBalance({
        lineTotal: Number(item.lineTotal),
        commissionAmount: Number(snap.commissionAmount),
        settlementCurrency: item.order.settlementCurrency || item.order.currency,
        paymentCurrency: item.order.paymentCurrency || item.order.currency,
        fxRate: item.order.fxRate == null ? null : Number(item.order.fxRate),
        balanceCurrency: balance.currency,
      });
      if (!quote) return { transferred: false, reason: 'nothing_to_transfer' };
      const amountMinor = Math.round(quote.amount * 100);
      if (amountMinor <= 0 || amountMinor > balance.amountMinor) {
        return { transferred: false, reason: 'exceeds_charge' };
      }
      const transfer = await this.stripe.createSupplierTransfer({
        amountCents: amountMinor,
        currency: quote.currency,
        destinationAccountId: item.supplier.stripeAccountId,
        sourceChargeId: balance.chargeId,
        idempotencyKey: `transfer-${item.id}-${quote.currency.toLowerCase()}`,
        orderItemId: item.id,
        supplierId: item.supplierId,
      });
      await this.prisma.orderItemCommission.update({
        where: { id: snap.id },
        data: {
          stripeTransferId: transfer.id,
          transferAmount: new Prisma.Decimal(quote.amount.toFixed(2)),
          transferCurrency: quote.currency,
          transferReversed: false,
        },
      });
      return { transferred: true, reason: 'ok' };
    } catch (error) {
      this.logger.warn(`Supplier transfer skipped: ${safeStripeMessage(error)}`);
      return { transferred: false, reason: 'stripe_error' };
    }
  }

  async reverseIfTransferred(orderItemId: string): Promise<void> {
    try {
      const snap = await this.prisma.orderItemCommission.findUnique({
        where: { orderItemId },
      });
      if (!snap?.stripeTransferId || snap.transferReversed) return;
      if (!this.stripe.connectTestReady()) return;
      await this.stripe.reverseSupplierTransfer({
        transferId: snap.stripeTransferId,
        idempotencyKey: `reversal-${orderItemId}`,
      });
      await this.prisma.orderItemCommission.update({
        where: { id: snap.id },
        data: { transferReversed: true },
      });
    } catch (error) {
      this.logger.warn(`Supplier transfer reversal skipped: ${safeStripeMessage(error)}`);
    }
  }

  private async syncAccount(supplierId: string, accountId: string) {
    const account = await this.stripe.retrieveConnectAccount(accountId);
    const enabled = account.payoutsEnabled && account.detailsSubmitted;
    await this.prisma.supplier.update({
      where: { id: supplierId },
      data: {
        stripePayoutsEnabled: enabled,
        ...(enabled ? { payoutSetupComplete: true } : {}),
      },
    });
  }

  private async requireSupplier(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: user.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  private findByState(state: string) {
    const token = state.trim();
    if (!token) return null;
    return this.prisma.supplier.findUnique({ where: { stripeConnectState: token } });
  }
}

function publicApiOrigin(): string {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  return `http://localhost:${Number.isFinite(port) ? port : 3000}`;
}

export function safeStripeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Stripe payout failed';
  return message.replace(/sk_(test|live)_[A-Za-z0-9]+/g, 'sk_redacted').slice(0, 300);
}
