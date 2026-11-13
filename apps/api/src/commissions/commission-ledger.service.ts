import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommissionActorType,
  CommissionAllocationReason,
  CommissionApplicationReversalReason,
  CommissionCreditApplicationReason,
  CommissionCreditReason,
  CommissionEvidenceStatus,
  CommissionRecognitionJobStatus,
  CommissionRemittanceMethod,
  CommissionRemittanceStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../auth/auth.types';
import { FxService } from '../fx/fx.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import {
  allocateOldestFirst,
  appliedRefundCredit,
  cashCommissionCollected,
  consumeCreditSources,
  grossCommissionOutstanding,
  lipaSuppliersReadyForPayment,
  netAmountDue,
  normalizePaymentReference,
  planClawbackRestoration,
  planRemittanceCreditInvalidation,
  remainingCredit,
  roundMoney,
  unappliedRefundCredit,
  unappliedVerifiedCash,
  verifiedUsdFromClaim,
} from './commission-ledger.math';
import {
  commissionReportRow,
  isReportableSettleable,
} from './commission.math';

type Db = Prisma.TransactionClient | PrismaService;

/** A human ledger actor, or Winger's sweep. systemKey is never written to AuditLog. */
type LedgerActor = {
  userId: string;
  systemKey: string | null;
};

const SWEEP_ACTOR: LedgerActor = {
  userId: 'commission-sweep',
  systemKey: 'commission-sweep',
};

function userActor(user: AuthUser): LedgerActor {
  return { userId: user.sub, systemKey: null };
}

@Injectable()
export class CommissionLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly fx: FxService,
  ) {}

  async receivingAccounts() {
    const settings = await this.ensureSettings();
    return {
      lipaNumber: settings.wingerLipaNumber,
      lipaNetwork: settings.wingerLipaNetwork,
      bankName: settings.wingerBankName,
      bankAccountName: settings.wingerBankAccountName,
      bankAccountNumber: settings.wingerBankAccountNumber,
    };
  }

  async updateReceivingAccounts(
    user: AuthUser,
    body: {
      lipaNumber?: string;
      lipaNetwork?: string;
      bankName?: string;
      bankAccountName?: string;
      bankAccountNumber?: string;
    },
  ) {
    this.requireAdmin(user);
    const current = await this.ensureSettings();
    const updated = await this.prisma.platformSettings.update({
      where: { id: 'default' },
      data: {
        wingerLipaNumber: (body.lipaNumber ?? current.wingerLipaNumber).trim(),
        wingerLipaNetwork: (body.lipaNetwork ?? current.wingerLipaNetwork).trim(),
        wingerBankName: (body.bankName ?? current.wingerBankName).trim(),
        wingerBankAccountName: (
          body.bankAccountName ?? current.wingerBankAccountName
        ).trim(),
        wingerBankAccountNumber: (
          body.bankAccountNumber ?? current.wingerBankAccountNumber
        ).trim(),
      },
    });
    await this.audit.record({
      entityType: 'PlatformSettings',
      entityId: 'default',
      action: 'COMMISSION_RECEIVING_ACCOUNTS_UPDATED',
      actorUserId: user.sub,
      actorRole: user.role,
      before: {
        lipaNumber: current.wingerLipaNumber,
        bankAccountNumber: current.wingerBankAccountNumber,
      },
      after: {
        lipaNumber: updated.wingerLipaNumber,
        bankAccountNumber: updated.wingerBankAccountNumber,
      },
    });
    return this.receivingAccounts();
  }

  async submitRemittance(
    user: AuthUser,
    body: {
      method: CommissionRemittanceMethod;
      claimedAmount: number;
      claimedCurrency: string;
      reference: string;
      provider?: string;
      merchantAccountKey?: string;
      note?: string;
    },
  ) {
    const supplierId = this.requireSupplier(user);
    if (
      body.method !== CommissionRemittanceMethod.WINGER_LIPA &&
      body.method !== CommissionRemittanceMethod.BANK_TRANSFER
    ) {
      throw new BadRequestException('Choose Lipa or bank transfer');
    }
    const referenceNormalized = normalizePaymentReference(body.reference ?? '');
    if (!referenceNormalized) {
      throw new BadRequestException('Payment reference is required');
    }
    const claimedAmount = roundMoney(Number(body.claimedAmount));
    if (!(claimedAmount > 0)) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    const claimedCurrency = (body.claimedCurrency ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(claimedCurrency)) {
      throw new BadRequestException('Currency is required');
    }
    const destination = await this.destinationFor(body.method, {
      provider: body.provider,
      merchantAccountKey: body.merchantAccountKey,
      adminRecorded: false,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const remittance = await tx.commissionRemittance.create({
          data: {
            supplierId,
            method: body.method,
            status: CommissionRemittanceStatus.SUBMITTED,
            claimedAmount: new Prisma.Decimal(claimedAmount.toFixed(2)),
            claimedCurrency,
            referenceRaw: body.reference.trim(),
            referenceNormalized,
            provider: destination.provider,
            merchantAccountKey: destination.merchantAccountKey,
            supplierNote: body.note?.trim() || null,
            submittedByUserId: user.sub,
          },
        });
        await tx.commissionPaymentReference.create({
          data: {
            remittanceId: remittance.id,
            method: body.method,
            provider: destination.provider,
            merchantAccountKey: destination.merchantAccountKey,
            currency: claimedCurrency,
            referenceNormalized,
          },
        });
        await this.audit.record({
          entityType: 'CommissionRemittance',
          entityId: remittance.id,
          action: 'REMITTANCE_SUBMITTED',
          actorUserId: user.sub,
          actorRole: user.role,
          after: { referenceNormalized, claimedAmount, claimedCurrency },
          tx,
        });
        return remittance;
      });
    } catch (error) {
      if (this.isUnique(error)) {
        throw new BadRequestException(
          'This payment reference is already in use',
        );
      }
      throw error;
    }
  }

  async recordAdminReceipt(
    user: AuthUser,
    body: {
      supplierId: string;
      method: CommissionRemittanceMethod;
      claimedAmount: number;
      claimedCurrency: string;
      reference: string;
      provider: string;
      merchantAccountKey: string;
      note?: string;
      confirmExchange?: boolean;
      fxRate?: number;
    },
  ) {
    this.requireAdmin(user);
    const referenceNormalized = normalizePaymentReference(body.reference ?? '');
    if (!referenceNormalized || !body.provider?.trim() || !body.merchantAccountKey?.trim()) {
      throw new BadRequestException(
        'Provider, receiving account, currency and reference are required',
      );
    }
    const destination = await this.destinationFor(body.method, {
      provider: body.provider,
      merchantAccountKey: body.merchantAccountKey,
      adminRecorded: true,
    });
    const claimedAmount = roundMoney(Number(body.claimedAmount));
    if (!(claimedAmount > 0)) {
      throw new BadRequestException('Payment amount must be greater than zero');
    }
    const claimedCurrency = body.claimedCurrency.trim().toUpperCase();
    try {
      const remittance = await this.prisma.$transaction(async (tx) => {
        const created = await tx.commissionRemittance.create({
          data: {
            supplierId: body.supplierId,
            method: body.method,
            status: CommissionRemittanceStatus.SUBMITTED,
            claimedAmount: new Prisma.Decimal(claimedAmount.toFixed(2)),
            claimedCurrency,
            referenceRaw: body.reference.trim(),
            referenceNormalized,
            provider: destination.provider,
            merchantAccountKey: destination.merchantAccountKey,
            supplierNote: body.note?.trim() || null,
            submittedByUserId: user.sub,
          },
        });
        await tx.commissionPaymentReference.create({
          data: {
            remittanceId: created.id,
            method: body.method,
            provider: destination.provider,
            merchantAccountKey: destination.merchantAccountKey,
            currency: claimedCurrency,
            referenceNormalized,
          },
        });
        return created;
      });
      return this.verifyRemittance(user, remittance.id, {
        confirmExchange: body.confirmExchange,
        fxRate: body.fxRate,
      });
    } catch (error) {
      if (this.isUnique(error)) {
        throw new BadRequestException(
          'This payment reference is already in use',
        );
      }
      throw error;
    }
  }

  async rejectRemittance(user: AuthUser, remittanceId: string, reviewNote: string) {
    this.requireAdmin(user);
    if (!reviewNote?.trim()) {
      throw new BadRequestException('A review note is required');
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockRemittance(tx, remittanceId);
      const remittance = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
      });
      if (!remittance) throw new NotFoundException('Remittance not found');
      if (
        remittance.status !== CommissionRemittanceStatus.SUBMITTED &&
        remittance.status !== CommissionRemittanceStatus.UNDER_REVIEW
      ) {
        throw new BadRequestException('This remittance can no longer be rejected');
      }
      await tx.commissionPaymentReference.deleteMany({ where: { remittanceId } });
      const updated = await tx.commissionRemittance.update({
        where: { id: remittanceId },
        data: {
          status: CommissionRemittanceStatus.REJECTED,
          reviewNote: reviewNote.trim(),
          reviewedByUserId: user.sub,
        },
      });
      await this.audit.record({
        entityType: 'CommissionRemittance',
        entityId: remittanceId,
        action: 'REMITTANCE_REJECTED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: { status: remittance.status },
        after: { status: updated.status, reviewNote: updated.reviewNote },
        tx,
      });
      return updated;
    });
  }

  async fxPreview(user: AuthUser, remittanceId: string) {
    this.requireAdmin(user);
    const remittance = await this.prisma.commissionRemittance.findUnique({
      where: { id: remittanceId },
    });
    if (!remittance) throw new NotFoundException('Remittance not found');
    const quote = await this.quoteClaim(remittance.claimedCurrency);
    return {
      claimedAmount: Number(remittance.claimedAmount),
      claimedCurrency: remittance.claimedCurrency,
      verifiedAmountUsd: this.verifiedAmountFor(remittance, quote),
      fxBaseCurrency: quote.fx?.baseCurrency ?? remittance.claimedCurrency,
      fxQuoteCurrency: quote.fx?.quoteCurrency ?? remittance.claimedCurrency,
      fxRate: quote.fx?.rate ?? 1,
      fxSource: quote.fx?.source ?? 'identity',
      fxFetchedAt: quote.fx?.fetchedAt ?? null,
    };
  }

  async verifyRemittance(
    user: AuthUser,
    remittanceId: string,
    body: {
      confirmExchange?: boolean;
      fxRate?: number;
      manualAllocations?: { snapshotId: string; amount: number }[];
    },
  ) {
    this.requireAdmin(user);
    return this.prisma.$transaction(async (tx) => {
      const peek = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
        select: { supplierId: true },
      });
      if (!peek) throw new NotFoundException('Remittance not found');
      await this.lockSupplierCredits(tx, peek.supplierId);
      await this.lockRemittance(tx, remittanceId);
      const remittance = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
      });
      if (!remittance) throw new NotFoundException('Remittance not found');
      if (remittance.status === CommissionRemittanceStatus.VERIFIED) {
        return remittance;
      }
      if (
        remittance.status !== CommissionRemittanceStatus.SUBMITTED &&
        remittance.status !== CommissionRemittanceStatus.UNDER_REVIEW
      ) {
        throw new BadRequestException('This remittance cannot be verified');
      }
      const quote = await this.quoteClaim(remittance.claimedCurrency);
      const verifiedAmountUsd = this.verifiedAmountFor(remittance, quote);
      if (quote.fx && body.confirmExchange !== true) {
        throw new BadRequestException(
          'Confirm the exchange rate before verifying this remittance',
        );
      }
      if (
        quote.fx &&
        body.fxRate != null &&
        Math.abs(Number(body.fxRate) - quote.fx.rate) > 0.0000001
      ) {
        throw new BadRequestException(
          'The exchange rate changed. Review the quote and verify again',
        );
      }
      const updated = await tx.commissionRemittance.update({
        where: { id: remittanceId },
        data: {
          status: CommissionRemittanceStatus.VERIFIED,
          verifiedAmountUsd: new Prisma.Decimal(verifiedAmountUsd.toFixed(2)),
          verifiedAt: new Date(),
          reviewedByUserId: user.sub,
          fxBaseCurrency: quote.fx?.baseCurrency ?? null,
          fxQuoteCurrency: quote.fx?.quoteCurrency ?? null,
          fxRate:
            quote.fx == null ? null : new Prisma.Decimal(quote.fx.rate.toFixed(8)),
          fxSource: quote.fx?.source ?? null,
          fxFetchedAt: quote.fx ? new Date(quote.fx.fetchedAt) : null,
          fxExpiresAt: quote.fx ? new Date(quote.fx.expiresAt) : null,
        },
      });
      await this.applyAvailableCredits(tx, remittance.supplierId, userActor(user));
      if (body.manualAllocations?.length) {
        await this.applyManualSlices(
          tx,
          updated.id,
          remittance.supplierId,
          body.manualAllocations,
          user,
        );
      } else {
        await this.allocateRemittanceCash(
          tx,
          updated.id,
          userActor(user),
          CommissionAllocationReason.AUTO,
        );
      }
      await this.audit.record({
        entityType: 'CommissionRemittance',
        entityId: remittanceId,
        action: 'REMITTANCE_VERIFIED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: { status: remittance.status },
        after: {
          status: CommissionRemittanceStatus.VERIFIED,
          verifiedAmountUsd,
          fxSource: quote.fx?.source ?? null,
        },
        tx,
      });
      return updated;
    });
  }

  async adjustAllocations(
    user: AuthUser,
    remittanceId: string,
    body: {
      apply?: { snapshotId: string; amount: number }[];
      release?: { allocationId: string; amount: number }[];
      autoApply?: boolean;
      reason: string;
    },
  ) {
    this.requireAdmin(user);
    if (!body.reason?.trim()) {
      throw new BadRequestException('A reason is required');
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockRemittance(tx, remittanceId);
      const remittance = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
      });
      if (!remittance || remittance.status !== CommissionRemittanceStatus.VERIFIED) {
        throw new BadRequestException('Only a verified remittance can be adjusted');
      }
      for (const release of body.release ?? []) {
        await this.releaseAllocation(tx, remittanceId, release, user);
      }
      if (body.apply?.length) {
        await this.applyManualSlices(
          tx,
          remittanceId,
          remittance.supplierId,
          body.apply,
          user,
        );
      }
      if (body.autoApply != null) {
        await tx.commissionRemittance.update({
          where: { id: remittanceId },
          data: { autoApply: body.autoApply },
        });
      }
      await this.audit.record({
        entityType: 'CommissionRemittance',
        entityId: remittanceId,
        action: 'REMITTANCE_ALLOCATION_ADJUSTED',
        actorUserId: user.sub,
        actorRole: user.role,
        after: { reason: body.reason.trim(), apply: body.apply ?? [], release: body.release ?? [] },
        tx,
      });
      return { ok: true };
    });
  }

  async reverseRemittance(
    user: AuthUser,
    remittanceId: string,
    body: { reason: string; providerEventId?: string },
  ) {
    this.requireAdmin(user);
    if (!body.reason?.trim()) {
      throw new BadRequestException('A reversal reason is required');
    }
    return this.prisma.$transaction(async (tx) => {
      const peek = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
        select: { supplierId: true },
      });
      if (!peek) throw new NotFoundException('Remittance not found');
      await this.lockSupplierCredits(tx, peek.supplierId);
      await this.lockRemittance(tx, remittanceId);
      const eventId = body.providerEventId?.trim();
      if (eventId) {
        const event = await tx.commissionProviderEvent.findUnique({
          where: { eventId },
          include: { remittanceReversal: true },
        });
        if (event?.remittanceReversal) {
          if (event.remittanceReversal.remittanceId !== remittanceId) {
            throw new BadRequestException(
              'This provider event is already linked to another reversal',
            );
          }
          return event.remittanceReversal;
        }
      }
      const existing = await tx.commissionRemittanceReversal.findUnique({
        where: { remittanceId },
      });
      if (existing) return existing;
      const remittance = await tx.commissionRemittance.findUnique({
        where: { id: remittanceId },
        include: {
          allocations: { include: { reversals: true, creditSources: true } },
        },
      });
      if (!remittance || remittance.status !== CommissionRemittanceStatus.VERIFIED) {
        throw new BadRequestException('Only a verified remittance can be reversed');
      }
      if (!remittance.verifiedAmountUsd) {
        throw new BadRequestException('This remittance has no verified amount');
      }
      const reversal = await tx.commissionRemittanceReversal.create({
        data: {
          remittanceId,
          amountUsd: remittance.verifiedAmountUsd,
          reason: body.reason.trim(),
          originalReference: remittance.referenceNormalized,
          actorUserId: user.sub,
        },
      });
      if (eventId) {
        try {
          await tx.commissionProviderEvent.create({
            data: {
              eventId,
              remittanceReversalId: reversal.id,
            },
          });
        } catch (error) {
          if (this.isUnique(error)) {
            throw new BadRequestException(
              'This provider event has already been processed',
            );
          }
          throw error;
        }
      }
      for (const allocation of remittance.allocations) {
        const active = this.activeAllocation(allocation);
        if (!(active > 0)) continue;
        await tx.commissionAllocationReversal.create({
          data: {
            allocationId: allocation.id,
            remittanceReversalId: reversal.id,
            amountUsd: new Prisma.Decimal(active.toFixed(2)),
            reason: 'REMITTANCE_REVERSED',
            reversalKey: `remittance-reversal:${reversal.id}:allocation:${allocation.id}`,
            actorUserId: user.sub,
          },
        });
      }
      const sourceIds = remittance.allocations.flatMap((row) =>
        row.creditSources.map((source) => source.id),
      );
      if (sourceIds.length) {
        const sources = await tx.commissionCreditSource.findMany({
          where: { id: { in: sourceIds } },
          include: {
            applicationSources: { include: { reversals: true } },
          },
        });
        const plan = planRemittanceCreditInvalidation({
          reversalId: reversal.id,
          creditSources: sources.map((source) => ({
            creditSourceId: source.id,
            creditId: source.creditId,
            amount: Number(source.amountUsd),
          })),
          applicationSources: sources.flatMap((source) =>
            source.applicationSources.map((row) => ({
              id: row.id,
              creditSourceId: source.id,
              active: this.activeApplicationSource(row),
              createdAt: row.createdAt.toISOString(),
            })),
          ),
        });
        for (const row of plan.applicationSourceReversals) {
          await tx.commissionCreditApplicationSourceReversal.create({
            data: {
              applicationSourceId: row.applicationSourceId,
              amountUsd: new Prisma.Decimal(row.amount.toFixed(2)),
              reason: CommissionApplicationReversalReason.REMITTANCE_REVERSED,
              reversalKey: row.reversalKey,
              remittanceReversalId: reversal.id,
              actorUserId: user.sub,
            },
          });
        }
        for (const offset of plan.offsets) {
          const created = await tx.commissionCreditOffset.create({
            data: {
              creditId: offset.creditId,
              amountUsd: new Prisma.Decimal(offset.amount.toFixed(2)),
              reason: 'REMITTANCE_REVERSED',
              remittanceReversalId: reversal.id,
              actorUserId: user.sub,
            },
          });
          for (const source of offset.sources) {
            await tx.commissionCreditOffsetSource.create({
              data: {
                offsetId: created.id,
                creditSourceId: source.creditSourceId,
                amountUsd: new Prisma.Decimal(source.amount.toFixed(2)),
              },
            });
          }
        }
      }
      await tx.commissionRemittance.update({
        where: { id: remittanceId },
        data: { status: CommissionRemittanceStatus.REVERSED },
      });
      await this.audit.record({
        entityType: 'CommissionRemittance',
        entityId: remittanceId,
        action: 'REMITTANCE_REVERSED',
        actorUserId: user.sub,
        actorRole: user.role,
        after: {
          reversalId: reversal.id,
          amountUsd: Number(reversal.amountUsd),
          reason: reversal.reason,
          originalReference: reversal.originalReference,
        },
        tx,
      });
      return reversal;
    });
  }

  async submitLipaEvidence(
    user: AuthUser,
    body: { orderId: string; reference: string; note?: string },
  ) {
    const supplierId = this.requireSupplier(user);
    const referenceNormalized = normalizePaymentReference(body.reference ?? '');
    if (!referenceNormalized) {
      throw new BadRequestException('Payment reference is required');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: body.orderId },
      include: { items: { where: { supplierId } } },
    });
    if (!order || order.items.length === 0) {
      throw new NotFoundException('Order not found for this supplier');
    }
    if (order.paymentMode !== 'lipa') {
      throw new BadRequestException(
        'Lipa evidence is only for supplier-direct Lipa orders',
      );
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const evidence = await tx.customerPaymentEvidence.create({
          data: {
            orderId: order.id,
            supplierId,
            referenceRaw: body.reference.trim(),
            referenceNormalized,
            note: body.note?.trim() || null,
            submittedByUserId: user.sub,
          },
        });
        await tx.customerPaymentEvidenceOpen.create({
          data: { orderId: order.id, supplierId, evidenceId: evidence.id },
        });
        await this.audit.record({
          entityType: 'CustomerPaymentEvidence',
          entityId: evidence.id,
          action: 'LIPA_EVIDENCE_SUBMITTED',
          actorUserId: user.sub,
          actorRole: user.role,
          after: { orderId: order.id, referenceNormalized },
          tx,
        });
        return evidence;
      });
    } catch (error) {
      if (this.isUnique(error)) {
        throw new BadRequestException(
          'This order already has Lipa evidence awaiting review',
        );
      }
      throw error;
    }
  }

  async reviewLipaEvidence(
    user: AuthUser,
    evidenceId: string,
    body: { approve: boolean; reviewNote?: string },
  ) {
    this.requireAdmin(user);
    const result = await this.prisma.$transaction(async (tx) => {
      const evidence = await tx.customerPaymentEvidence.findUnique({
        where: { id: evidenceId },
      });
      if (!evidence) throw new NotFoundException('Lipa evidence not found');
      await this.lockOrder(tx, evidence.orderId);
      const order = await tx.order.findUnique({
        where: { id: evidence.orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      const current = await tx.customerPaymentEvidence.findUnique({
        where: { id: evidenceId },
      });
      if (!current) throw new NotFoundException('Lipa evidence not found');
      if (
        current.status !== CommissionEvidenceStatus.SUBMITTED &&
        current.status !== CommissionEvidenceStatus.UNDER_REVIEW
      ) {
        const pendingJobs = await tx.commissionRecognitionJob.count({
          where: {
            orderId: order.id,
            status: { not: CommissionRecognitionJobStatus.COMPLETED },
          },
        });
        return {
          evidence: current,
          orderId: order.id,
          recoveryRequired: pendingJobs > 0,
        };
      }
      const status = body.approve
        ? CommissionEvidenceStatus.VERIFIED
        : CommissionEvidenceStatus.REJECTED;
      if (!body.approve && !body.reviewNote?.trim()) {
        throw new BadRequestException('A review note is required to reject');
      }
      const updated = await tx.customerPaymentEvidence.update({
        where: { id: evidenceId },
        data: {
          status,
          reviewNote: body.reviewNote?.trim() || null,
          reviewedByUserId: user.sub,
          reviewedAt: new Date(),
        },
      });
      await tx.customerPaymentEvidenceOpen.deleteMany({
        where: { evidenceId },
      });
      let recoveryRequired = false;
      if (body.approve && order.paymentMode === 'lipa') {
        const live = order.items.filter(
          (item) =>
            item.status !== OrderStatus.CANCELLED &&
            item.status !== OrderStatus.RETURNED,
        );
        const supplierIds = [...new Set(live.map((item) => item.supplierId))];
        const verified = await tx.customerPaymentEvidence.findMany({
          where: {
            orderId: order.id,
            supplierId: { in: supplierIds },
            status: CommissionEvidenceStatus.VERIFIED,
          },
        });
        const verifiedIds = new Set(verified.map((row) => row.supplierId));
        verifiedIds.add(current.supplierId);
        if (
          lipaSuppliersReadyForPayment({
            paymentMode: order.paymentMode,
            liveSupplierIds: supplierIds,
            verifiedSupplierIds: [...verifiedIds],
          })
        ) {
          await tx.order.updateMany({
            where: {
              id: order.id,
              paymentMode: 'lipa',
              paymentStatus: PaymentStatus.PENDING,
            },
            data: { paymentStatus: PaymentStatus.PAID },
          });
          const paid = await tx.order.findUnique({
            where: { id: order.id },
            select: { paymentMode: true, paymentStatus: true },
          });
          if (
            paid?.paymentMode === 'lipa' &&
            paid.paymentStatus === PaymentStatus.PAID
          ) {
            await tx.commissionRecognitionJob.createMany({
              data: live.map((item) => ({
                id: randomUUID(),
                orderId: order.id,
                orderItemId: item.id,
                supplierId: item.supplierId,
              })),
              skipDuplicates: true,
            });
            recoveryRequired = true;
          }
        }
      }
      await this.audit.record({
        entityType: 'CustomerPaymentEvidence',
        entityId: evidenceId,
        action: body.approve ? 'LIPA_EVIDENCE_VERIFIED' : 'LIPA_EVIDENCE_REJECTED',
        actorUserId: user.sub,
        actorRole: user.role,
        after: { status, recoveryRequired },
        tx,
      });
      return { evidence: updated, orderId: order.id, recoveryRequired };
    });
    return result;
  }

  async restoreAfterClawback(
    tx: Prisma.TransactionClient,
    snapshotId: string,
    actor: AuthUser,
  ) {
    const snapshot = await tx.orderItemCommission.findUnique({
      where: { id: snapshotId },
      include: {
        orderItem: true,
        cashAllocations: { include: { reversals: true } },
        creditApplications: {
          include: { sources: { include: { reversals: true } } },
        },
      },
    });
    if (!snapshot) return { restored: false };
    const plan = planClawbackRestoration({
      snapshotId,
      activeApplicationSources: snapshot.creditApplications.flatMap((application) =>
        application.sources.map((source) => ({
          id: source.id,
          active: this.activeApplicationSource(source),
        })),
      ),
      activeCashAllocations: snapshot.cashAllocations.map((allocation) => ({
        allocationId: allocation.id,
        amount: this.activeAllocation(allocation),
      })),
    });
    for (const reversal of plan.applicationSourceReversals) {
      const already = await tx.commissionCreditApplicationSourceReversal.findUnique({
        where: { reversalKey: reversal.reversalKey },
      });
      if (already) continue;
      await tx.commissionCreditApplicationSourceReversal.create({
        data: {
          applicationSourceId: reversal.applicationSourceId,
          amountUsd: new Prisma.Decimal(reversal.amount.toFixed(2)),
          reason: CommissionApplicationReversalReason.CUSTOMER_REFUND,
          reversalKey: reversal.reversalKey,
          actorUserId: actor.sub,
        },
      });
    }
    if (plan.cashCredit) {
      const existing = await tx.commissionCredit.findUnique({
        where: { sourceEventKey: plan.cashCredit.sourceEventKey },
      });
      if (!existing) {
        await tx.commissionCredit.create({
          data: {
            supplierId: snapshot.orderItem.supplierId,
            orderItemCommissionId: snapshotId,
            amountUsd: new Prisma.Decimal(plan.cashCredit.amount.toFixed(2)),
            reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
            sourceEventKey: plan.cashCredit.sourceEventKey,
            actorUserId: actor.sub,
            sources: {
              create: plan.cashCredit.sources.map((source) => ({
                allocationId: source.allocationId,
                amountUsd: new Prisma.Decimal(source.amount.toFixed(2)),
              })),
            },
          },
        });
      }
    }
    await this.audit.record({
      entityType: 'OrderItemCommission',
      entityId: snapshotId,
      action: 'COMMISSION_CREDIT_RESTORED',
      actorUserId: actor.sub,
      actorRole: actor.role,
      after: {
        restoredApplications: plan.applicationSourceReversals.length,
        cashCredit: plan.cashCredit?.amount ?? 0,
      },
      tx,
    });
    return { restored: true };
  }

  async sweepSupplier(supplierId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockSupplierCredits(tx, supplierId);
      const remittances = await tx.commissionRemittance.findMany({
        where: {
          supplierId,
          status: CommissionRemittanceStatus.VERIFIED,
          autoApply: true,
        },
        orderBy: { id: 'asc' },
      });
      for (const remittance of remittances) {
        await this.lockRemittance(tx, remittance.id);
      }
      await this.applyAvailableCredits(tx, supplierId, SWEEP_ACTOR);
      const ordered = [...remittances].sort((a, b) => {
        const left = a.verifiedAt?.getTime() ?? 0;
        const right = b.verifiedAt?.getTime() ?? 0;
        if (left !== right) return left - right;
        return a.id.localeCompare(b.id);
      });
      for (const remittance of ordered) {
        await this.allocateRemittanceCash(
          tx,
          remittance.id,
          SWEEP_ACTOR,
          CommissionAllocationReason.SWEEP,
        );
      }
    });
  }

  async recognitionJobs(orderId: string) {
    if (typeof orderId !== 'string' || !orderId.trim()) {
      throw new BadRequestException('Order id is required');
    }
    return this.prisma.commissionRecognitionJob.findMany({
      where: {
        orderId: orderId.trim(),
        status: {
          in: [
            CommissionRecognitionJobStatus.PENDING,
            CommissionRecognitionJobStatus.AWAITING_SWEEP,
          ],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  async assertOrderRecoveryScope(orderId: string, supplierId?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { items: { select: { supplierId: true } } },
    });
    if (!order) {
      throw new BadRequestException('Order id is not valid');
    }
    if (supplierId && !order.items.some((item) => item.supplierId === supplierId)) {
      throw new BadRequestException('Supplier id is not valid for this order');
    }
  }

  async setRecognitionJobStatus(id: string, status: CommissionRecognitionJobStatus) {
    return this.prisma.commissionRecognitionJob.update({
      where: { id },
      data: {
        status,
        completedAt:
          status === CommissionRecognitionJobStatus.COMPLETED ? new Date() : null,
      },
    });
  }

  async listAllocationActivity(
    user: AuthUser,
    query: { supplierId?: string; remittanceId?: string },
  ) {
    this.requireAdmin(user);
    let supplierId = query.supplierId?.trim() || undefined;
    if (!supplierId && query.remittanceId) {
      const remittance = await this.prisma.commissionRemittance.findUnique({
        where: { id: query.remittanceId },
        select: { supplierId: true },
      });
      supplierId = remittance?.supplierId;
    }
    const allocations = await this.prisma.commissionAllocation.findMany({
      where: {
        ...(query.remittanceId ? { remittanceId: query.remittanceId } : {}),
        ...(supplierId ? { remittance: { supplierId } } : {}),
      },
      include: {
        remittance: { select: { supplierId: true } },
        orderItemCommission: { select: { orderItemId: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const creditApplications = await this.prisma.commissionCreditApplication.findMany({
      where: supplierId ? { credit: { supplierId } } : {},
      include: {
        credit: { select: { supplierId: true } },
        orderItemCommission: { select: { orderItemId: true } },
        sources: { include: { reversals: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    return {
      allocations: allocations.map((row) => toAdminAllocation(row)),
      creditApplications: creditApplications.map((row) => toAdminCreditApplication(row)),
    };
  }

  async supplierAccount(user: AuthUser) {
    const supplierId = this.requireSupplier(user);
    return this.accountForSupplier(supplierId);
  }

  async adminAccounts(user: AuthUser) {
    this.requireAdmin(user);
    const suppliers = await this.prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const accounts = [];
    for (const supplier of suppliers) {
      accounts.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        ...(await this.accountForSupplier(supplier.id)),
      });
    }
    return { suppliers: accounts };
  }

  async listRemittances(user: AuthUser, supplierId?: string) {
    const owner =
      user.role === UserRole.SUPPLIER ? this.requireSupplier(user) : supplierId;
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPPLIER) {
      throw new ForbiddenException('Commission account required');
    }
    const rows = await this.prisma.commissionRemittance.findMany({
      where: owner ? { supplierId: owner } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { allocations: { include: { reversals: true } }, reversal: true },
    });
    return rows.map((row) => {
      const allocated = roundMoney(
        row.allocations.reduce((sum, allocation) => sum + this.activeAllocation(allocation), 0),
      );
      const verified = row.verifiedAmountUsd == null ? null : Number(row.verifiedAmountUsd);
      return {
        id: row.id,
        supplierId: row.supplierId,
        method: row.method,
        status: row.status,
        claimedAmount: Number(row.claimedAmount),
        claimedCurrency: row.claimedCurrency,
        verifiedAmountUsd: verified,
        reference: row.referenceRaw,
        provider: row.provider,
        merchantAccountKey: row.merchantAccountKey,
        allocated,
        unapplied: verified == null || row.status !== CommissionRemittanceStatus.VERIFIED
          ? 0
          : roundMoney(verified - allocated),
        createdAt: row.createdAt.toISOString(),
        reversalReason: row.reversal?.reason ?? null,
      };
    });
  }

  async heldFunds(user: AuthUser) {
    this.requireAdmin(user);
    const [shipments, bookings, snapshots] = await Promise.all([
      this.prisma.orderShipment.findMany(),
      this.prisma.courierBooking.findMany({ where: { status: 'booked' } }),
      this.prisma.orderItemCommission.findMany({
        where: { isDemo: false },
        include: {
          orderItem: {
            include: {
              order: { include: { cashCollections: { select: { supplierId: true } } } },
            },
          },
        },
      }),
    ]);
    const merchandise = roundMoney(
      shipments.reduce((sum, row) => sum + Number(row.merchandise), 0),
    );
    const taxHeld = roundMoney(
      shipments.reduce(
        (sum, row) => sum + Number(row.merchandiseTax) + Number(row.deliveryTax),
        0,
      ),
    );
    const deliveryCollected = roundMoney(
      shipments.reduce((sum, row) => sum + Number(row.deliveryFee), 0),
    );
    const courierFeeMemo = roundMoney(
      bookings.reduce((sum, row) => sum + Number(row.fee ?? 0), 0),
    );
    let retained = 0;
    for (const row of snapshots) {
      const report = commissionReportRow(row);
      if (
        row.status === 'SETTLEABLE' &&
        isReportableSettleable(report) &&
        (row.paymentMode === 'test' || row.paymentMode === 'live')
      ) {
        retained += Number(row.commissionAmount);
      }
    }
    return {
      merchandiseSales: merchandise,
      taxHeld: roundMoney(taxHeld),
      deliveryChargesCollected: deliveryCollected,
      courierFeeMemo,
      commissionRetained: roundMoney(retained),
      taxAndDeliveryAreNotCommission: true,
    };
  }

  private async accountForSupplier(supplierId: string) {
    const snapshots = await this.prisma.orderItemCommission.findMany({
      where: { orderItem: { supplierId }, isDemo: false },
      include: {
        orderItem: {
          include: {
            order: { include: { cashCollections: { select: { supplierId: true } } } },
          },
        },
        cashAllocations: { include: { reversals: true, remittance: true } },
        creditApplications: { include: { sources: { include: { reversals: true } } } },
      },
    });
    const remittances = await this.prisma.commissionRemittance.findMany({
      where: { supplierId, status: CommissionRemittanceStatus.VERIFIED },
      include: { allocations: { include: { reversals: true } } },
    });
    const credits = await this.prisma.commissionCredit.findMany({
      where: { supplierId },
      include: {
        offsets: { include: { sources: true } },
        applications: { include: { sources: { include: { reversals: true } } } },
      },
    });
    let pending = 0;
    let recognised = 0;
    let retained = 0;
    const grossLines: { commissionAmount: number; cashAllocated: number }[] = [];
    for (const row of snapshots) {
      const amount = Number(row.commissionAmount);
      const report = commissionReportRow(row);
      if (row.status === 'PENDING') pending += amount;
      if (row.status === 'RECOGNIZED') recognised += amount;
      const eligible =
        row.status === 'SETTLEABLE' &&
        isReportableSettleable(report) &&
        (row.paymentMode === 'cod' || row.paymentMode === 'lipa');
      const cardRetained =
        row.status === 'SETTLEABLE' &&
        isReportableSettleable(report) &&
        (row.paymentMode === 'test' || row.paymentMode === 'live');
      if (cardRetained) retained += amount;
      if (!eligible) continue;
      const cashAllocated = roundMoney(
        row.cashAllocations
          .filter((allocation) => allocation.remittance.status === CommissionRemittanceStatus.VERIFIED)
          .reduce((sum, allocation) => sum + this.activeAllocation(allocation), 0),
      );
      grossLines.push({ commissionAmount: amount, cashAllocated });
    }
    const appliedSources = credits.flatMap((credit) =>
      credit.applications.flatMap((application) =>
        application.sources.map((source) => this.activeApplicationSource(source)),
      ),
    );
    const gross = grossCommissionOutstanding(grossLines);
    const applied = appliedRefundCredit(appliedSources);
    const unappliedCash = unappliedVerifiedCash(
      remittances.map((remittance) => ({
        verifiedAmountUsd: Number(remittance.verifiedAmountUsd ?? 0),
        cashAllocated: roundMoney(
          remittance.allocations.reduce(
            (sum, allocation) => sum + this.activeAllocation(allocation),
            0,
          ),
        ),
      })),
    );
    const collected = cashCommissionCollected(
      remittances.flatMap((remittance) =>
        remittance.allocations.map((allocation) => this.activeAllocation(allocation)),
      ),
    );
    const unappliedCredit = unappliedRefundCredit(
      credits.map((credit) => ({
        amount: Number(credit.amountUsd),
        offsets: roundMoney(
          credit.offsets.reduce((sum, offset) => sum + Number(offset.amountUsd), 0),
        ),
        applied: roundMoney(
          credit.applications.reduce(
            (sum, application) =>
              sum +
              application.sources.reduce(
                (inner, source) => inner + this.activeApplicationSource(source),
                0,
              ),
            0,
          ),
        ),
      })),
    );
    return {
      pendingRecognition: roundMoney(pending),
      recognisedAwaitingDelivery: roundMoney(recognised),
      earnedRetained: roundMoney(retained),
      grossCommissionOutstanding: gross,
      unappliedVerifiedCash: unappliedCash,
      appliedRefundCredit: applied,
      unappliedRefundCredit: unappliedCredit,
      cashCommissionCollected: collected,
      netAmountDue: netAmountDue(gross, applied, unappliedCash),
    };
  }

  private async allocateRemittanceCash(
    tx: Prisma.TransactionClient,
    remittanceId: string,
    actor: LedgerActor,
    reason: CommissionAllocationReason,
  ) {
    const remittance = await tx.commissionRemittance.findUnique({
      where: { id: remittanceId },
      include: { allocations: { include: { reversals: true } } },
    });
    if (!remittance?.verifiedAmountUsd) return;
    const allocated = roundMoney(
      remittance.allocations.reduce(
        (sum, allocation) => sum + this.activeAllocation(allocation),
        0,
      ),
    );
    const left = roundMoney(Number(remittance.verifiedAmountUsd) - allocated);
    if (!(left > 0)) return;
    const lines = await this.eligibleLines(tx, remittance.supplierId);
    const slices = allocateOldestFirst(lines, left);
    for (const slice of slices) {
      const created = await tx.commissionAllocation.create({
        data: {
          remittanceId,
          orderItemCommissionId: slice.snapshotId,
          amountUsd: new Prisma.Decimal(slice.amount.toFixed(2)),
          reason,
          ...this.actorColumns(actor),
        },
      });
      await this.recordSystemEvent(tx, actor, {
        entityType: 'CommissionAllocation',
        entityId: created.id,
        action: 'COMMISSION_ALLOCATED',
        supplierId: remittance.supplierId,
        after: {
          remittanceId,
          orderItemCommissionId: slice.snapshotId,
          amountUsd: slice.amount,
          reason,
        },
      });
    }
  }

  private async applyManualSlices(
    tx: Prisma.TransactionClient,
    remittanceId: string,
    supplierId: string,
    slices: { snapshotId: string; amount: number }[],
    actor: AuthUser,
  ) {
    const remittance = await tx.commissionRemittance.findUnique({
      where: { id: remittanceId },
      include: { allocations: { include: { reversals: true } } },
    });
    if (!remittance?.verifiedAmountUsd) {
      throw new BadRequestException('This remittance has no verified amount');
    }
    let unapplied = roundMoney(
      Number(remittance.verifiedAmountUsd) -
        remittance.allocations.reduce(
          (sum, allocation) => sum + this.activeAllocation(allocation),
          0,
        ),
    );
    const lines = await this.eligibleLines(tx, supplierId);
    const remaining = new Map(lines.map((line) => [line.id, line.remaining]));
    for (const slice of slices) {
      const amount = roundMoney(Number(slice.amount));
      const lineRemaining = remaining.get(slice.snapshotId) ?? 0;
      if (!(amount > 0) || amount > unapplied + 0.001 || amount > lineRemaining + 0.001) {
        throw new BadRequestException(
          'Allocation exceeds the remittance balance or the commission payable',
        );
      }
      await tx.commissionAllocation.create({
        data: {
          remittanceId,
          orderItemCommissionId: slice.snapshotId,
          amountUsd: new Prisma.Decimal(amount.toFixed(2)),
          reason: CommissionAllocationReason.MANUAL,
          ...this.actorColumns(userActor(actor)),
        },
      });
      unapplied = roundMoney(unapplied - amount);
      remaining.set(slice.snapshotId, roundMoney(lineRemaining - amount));
    }
  }

  private async releaseAllocation(
    tx: Prisma.TransactionClient,
    remittanceId: string,
    release: { allocationId: string; amount: number },
    actor: AuthUser,
  ) {
    const allocation = await tx.commissionAllocation.findUnique({
      where: { id: release.allocationId },
      include: { reversals: true },
    });
    if (!allocation || allocation.remittanceId !== remittanceId) {
      throw new BadRequestException('Allocation not found on this remittance');
    }
    const active = this.activeAllocation(allocation);
    const amount = roundMoney(Number(release.amount));
    if (!(amount > 0) || amount > active + 0.001) {
      throw new BadRequestException('Release exceeds the active allocation');
    }
    await tx.commissionAllocationReversal.create({
      data: {
        allocationId: allocation.id,
        amountUsd: new Prisma.Decimal(amount.toFixed(2)),
        reason: 'MANUAL',
        reversalKey: `manual:${randomUUID()}`,
        actorUserId: actor.sub,
      },
    });
  }

  private async applyAvailableCredits(
    tx: Prisma.TransactionClient,
    supplierId: string,
    actor: LedgerActor,
  ) {
    await this.lockSupplierCredits(tx, supplierId);
    const credits = await tx.commissionCredit.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'asc' },
      include: {
        sources: {
          orderBy: { createdAt: 'asc' },
          include: {
            applicationSources: { include: { reversals: true } },
            offsetSources: true,
          },
        },
        offsets: true,
        applications: { include: { sources: { include: { reversals: true } } } },
      },
    });
    for (const credit of credits) {
      const applied = roundMoney(
        credit.applications.reduce(
          (sum, application) =>
            sum +
            application.sources.reduce(
              (inner, source) => inner + this.activeApplicationSource(source),
              0,
            ),
          0,
        ),
      );
      const offsets = roundMoney(
        credit.offsets.reduce((sum, offset) => sum + Number(offset.amountUsd), 0),
      );
      let available = remainingCredit(Number(credit.amountUsd), offsets, applied);
      if (!(available > 0)) continue;
      const lines = await this.eligibleLines(tx, supplierId);
      const slices = allocateOldestFirst(lines, available);
      for (const slice of slices) {
        const capacities = credit.sources.map((source) => ({
          sourceId: source.id,
          createdAt: source.createdAt.toISOString(),
          remaining: remainingCredit(
            Number(source.amountUsd),
            source.offsetSources.reduce((sum, row) => sum + Number(row.amountUsd), 0),
            source.applicationSources.reduce(
              (sum, row) => sum + this.activeApplicationSource(row),
              0,
            ),
          ),
        }));
        const consumed = consumeCreditSources(capacities, slice.amount);
        const application = await tx.commissionCreditApplication.create({
          data: {
            creditId: credit.id,
            orderItemCommissionId: slice.snapshotId,
            amountUsd: new Prisma.Decimal(slice.amount.toFixed(2)),
            reason: CommissionCreditApplicationReason.AUTO,
            ...this.actorColumns(actor),
          },
        });
        for (const source of consumed) {
          await tx.commissionCreditApplicationSource.create({
            data: {
              applicationId: application.id,
              creditSourceId: source.sourceId,
              amountUsd: new Prisma.Decimal(source.amount.toFixed(2)),
            },
          });
          const loaded = credit.sources.find((row) => row.id === source.sourceId);
          loaded?.applicationSources.push({
            id: `pending-${source.sourceId}`,
            createdAt: new Date(),
            amountUsd: new Prisma.Decimal(source.amount.toFixed(2)),
            applicationId: application.id,
            creditSourceId: source.sourceId,
            reversals: [],
          });
        }
        await this.recordSystemEvent(tx, actor, {
          entityType: 'CommissionCreditApplication',
          entityId: application.id,
          action: 'COMMISSION_CREDIT_APPLIED',
          supplierId,
          after: {
            creditId: credit.id,
            orderItemCommissionId: slice.snapshotId,
            amountUsd: slice.amount,
            sources: consumed,
          },
        });
        available = roundMoney(available - slice.amount);
      }
    }
  }

  private async eligibleLines(tx: Db, supplierId: string) {
    const rows = await tx.orderItemCommission.findMany({
      where: {
        isDemo: false,
        status: 'SETTLEABLE',
        paymentMode: { in: ['cod', 'lipa'] },
        orderItem: { supplierId, status: OrderStatus.DELIVERED },
      },
      include: {
        orderItem: {
          include: {
            order: { include: { cashCollections: { select: { supplierId: true } } } },
          },
        },
        cashAllocations: { include: { reversals: true, remittance: true } },
        creditApplications: { include: { sources: { include: { reversals: true } } } },
      },
      orderBy: [{ settleableAt: 'asc' }, { id: 'asc' }],
    });
    const lines = [];
    for (const row of rows) {
      const report = commissionReportRow(row);
      if (!isReportableSettleable(report)) continue;
      const cashAllocated = roundMoney(
        row.cashAllocations
          .filter((allocation) => allocation.remittance.status === 'VERIFIED')
          .reduce((sum, allocation) => sum + this.activeAllocation(allocation), 0),
      );
      const creditApplied = roundMoney(
        row.creditApplications.reduce(
          (sum, application) =>
            sum +
            application.sources.reduce(
              (inner, source) => inner + this.activeApplicationSource(source),
              0,
            ),
          0,
        ),
      );
      const remaining = roundMoney(
        Number(row.commissionAmount) - cashAllocated - creditApplied,
      );
      if (remaining > 0 && row.settleableAt) {
        lines.push({
          id: row.id,
          settleableAt: row.settleableAt.toISOString(),
          remaining,
        });
      }
    }
    return lines;
  }

  private async quoteClaim(claimedCurrency: string) {
    const settings = await this.ensureSettings();
    const settlement = (settings.currency || 'USD').toUpperCase();
    const claimed = claimedCurrency.trim().toUpperCase();
    if (claimed === settlement) {
      return {
        amount: 0,
        fx: null as null | {
          baseCurrency: string;
          quoteCurrency: string;
          rate: number;
          source: string;
          fetchedAt: string;
          expiresAt: string;
        },
        claimed,
        settlement,
      };
    }
    let fx;
    try {
      fx = await this.fx.quote(claimed, settlement);
    } catch {
      fx = await this.fx.quote(settlement, claimed);
    }
    if (fx.source === 'dev-seed') {
      throw new BadRequestException(
        'Refresh exchange rates before verifying a foreign-currency remittance',
      );
    }
    return { amount: 0, fx, claimed, settlement };
  }

  private verifiedAmountFor(remittance: {
    claimedAmount: Prisma.Decimal;
    claimedCurrency: string;
  }, quote: Awaited<ReturnType<CommissionLedgerService['quoteClaim']>>) {
    return verifiedUsdFromClaim({
      claimedAmount: Number(remittance.claimedAmount),
      claimedCurrency: quote.claimed,
      settlementCurrency: quote.settlement,
      quoteBase: quote.fx?.baseCurrency ?? quote.settlement,
      quoteCurrency: quote.fx?.quoteCurrency ?? quote.settlement,
      rate: quote.fx?.rate ?? 1,
    });
  }

  private async destinationFor(
    method: CommissionRemittanceMethod,
    input: { provider?: string; merchantAccountKey?: string; adminRecorded: boolean },
  ) {
    const settings = await this.ensureSettings();
    const lipa = normalizePaymentReference(settings.wingerLipaNumber);
    const bank = normalizePaymentReference(settings.wingerBankAccountNumber);
    if (method === CommissionRemittanceMethod.WINGER_LIPA) {
      if (!lipa) throw new BadRequestException('Winger Lipa number is not configured');
      return {
        provider: (settings.wingerLipaNetwork || 'LIPA').trim().toUpperCase(),
        merchantAccountKey: lipa,
      };
    }
    if (method === CommissionRemittanceMethod.BANK_TRANSFER) {
      if (!bank) throw new BadRequestException('Winger bank account is not configured');
      return { provider: 'BANK', merchantAccountKey: bank };
    }
    const provider = (input.provider ?? '').trim().toUpperCase();
    const merchantAccountKey = normalizePaymentReference(input.merchantAccountKey ?? '');
    if (!provider || !merchantAccountKey) {
      throw new BadRequestException(
        'Provider, receiving account, currency and reference are required',
      );
    }
    const allowed = new Set([lipa, bank].filter(Boolean));
    if (input.adminRecorded && !allowed.has(merchantAccountKey)) {
      throw new BadRequestException(
        'Record the payment against a configured Winger receiving account',
      );
    }
    return { provider, merchantAccountKey };
  }

  private actorColumns(actor: LedgerActor) {
    if (actor.systemKey) {
      return {
        actorUserId: actor.systemKey,
        actorType: CommissionActorType.SYSTEM,
        systemActorKey: actor.systemKey,
      };
    }
    return {
      actorUserId: actor.userId,
      actorType: CommissionActorType.USER,
      systemActorKey: null,
    };
  }

  private async recordSystemEvent(
    tx: Prisma.TransactionClient,
    actor: LedgerActor,
    input: {
      entityType: string;
      entityId: string;
      action: string;
      supplierId: string;
      after: Prisma.InputJsonValue;
    },
  ) {
    if (!actor.systemKey) return;
    await tx.commissionSystemEvent.create({
      data: {
        actorType: CommissionActorType.SYSTEM,
        systemActorKey: actor.systemKey,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        supplierId: input.supplierId,
        afterJson: input.after,
      },
    });
  }

  private async lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException('Order not found');
  }

  /**
   * Credits first, then their sources, always in id order.
   * Remittance locks happen after this so a sweep and a verification cannot deadlock.
   */
  private async lockSupplierCredits(tx: Prisma.TransactionClient, supplierId: string) {
    await tx.$queryRaw`
      SELECT id FROM "CommissionCredit"
      WHERE "supplierId" = ${supplierId}
      ORDER BY id
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT s.id
      FROM "CommissionCreditSource" s
      INNER JOIN "CommissionCredit" c ON c.id = s."creditId"
      WHERE c."supplierId" = ${supplierId}
      ORDER BY s.id
      FOR UPDATE
    `;
  }

  private async lockRemittance(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "CommissionRemittance" WHERE id = ${id} FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException('Remittance not found');
  }

  private activeAllocation(allocation: {
    amountUsd: Prisma.Decimal | number;
    reversals: { amountUsd: Prisma.Decimal | number }[];
  }) {
    const reversed = allocation.reversals.reduce(
      (sum, reversal) => sum + Number(reversal.amountUsd),
      0,
    );
    return roundMoney(Number(allocation.amountUsd) - reversed);
  }

  private activeApplicationSource(source: {
    amountUsd: Prisma.Decimal | number;
    reversals: { amountUsd: Prisma.Decimal | number }[];
  }) {
    const reversed = source.reversals.reduce(
      (sum, reversal) => sum + Number(reversal.amountUsd),
      0,
    );
    return roundMoney(Number(source.amountUsd) - reversed);
  }

  private async ensureSettings() {
    return this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', defaultCommissionPercent: new Prisma.Decimal(10) },
      update: {},
    });
  }

  private requireAdmin(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can do this');
    }
  }

  private requireSupplier(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    return user.supplierId;
  }

  private isUnique(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
    );
  }
}

export function toAdminAllocation(row: {
  id: string;
  remittanceId: string;
  orderItemCommissionId: string;
  amountUsd: Prisma.Decimal | number;
  reason: string;
  actorType: CommissionActorType | string;
  systemActorKey: string | null;
  actorUserId: string;
  createdAt: Date;
  remittance: { supplierId: string };
  orderItemCommission: { orderItemId: string };
}) {
  const system = row.actorType === CommissionActorType.SYSTEM;
  return {
    id: row.id,
    remittanceId: row.remittanceId,
    supplierId: row.remittance.supplierId,
    orderItemCommissionId: row.orderItemCommissionId,
    orderItemId: row.orderItemCommission.orderItemId,
    amountUsd: Number(row.amountUsd),
    reason: row.reason,
    actorType: row.actorType,
    systemActor: row.systemActorKey,
    actorUserId: system ? null : row.actorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAdminCreditApplication(row: {
  id: string;
  creditId: string;
  orderItemCommissionId: string;
  amountUsd: Prisma.Decimal | number;
  reason: string;
  actorType: CommissionActorType | string;
  systemActorKey: string | null;
  actorUserId: string;
  createdAt: Date;
  credit: { supplierId: string };
  orderItemCommission: { orderItemId: string };
  sources: {
    creditSourceId: string;
    amountUsd: Prisma.Decimal | number;
    reversals: { amountUsd: Prisma.Decimal | number }[];
  }[];
}) {
  const system = row.actorType === CommissionActorType.SYSTEM;
  return {
    id: row.id,
    creditId: row.creditId,
    supplierId: row.credit.supplierId,
    orderItemCommissionId: row.orderItemCommissionId,
    orderItemId: row.orderItemCommission.orderItemId,
    amountUsd: Number(row.amountUsd),
    reason: row.reason,
    actorType: row.actorType,
    systemActor: row.systemActorKey,
    actorUserId: system ? null : row.actorUserId,
    createdAt: row.createdAt.toISOString(),
    sources: row.sources.map((source) => ({
      creditSourceId: source.creditSourceId,
      amountUsd: Number(source.amountUsd),
      activeAmountUsd: roundMoney(
        Number(source.amountUsd) -
          source.reversals.reduce((sum, reversal) => sum + Number(reversal.amountUsd), 0),
      ),
    })),
  };
}
