import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommissionAgreementStatus,
  CommissionRecognitionStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { assertValidRatePercent, buildSnapshotValues, roundMoney } from './commission.math';

export type UpdateDefaultCommissionDto = {
  defaultCommissionPercent: number;
};

export type ProposeAgreementDto = {
  supplierId: string;
  ratePercent: number;
  notes?: string;
};

export type CounterAgreementDto = {
  ratePercent: number;
  notes?: string;
};

@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getSettings() {
    const settings = await this.ensureSettings();
    return {
      defaultCommissionPercent: Number(settings.defaultCommissionPercent),
      currency: settings.currency,
      commissionsConfigured: settings.commissionsConfigured,
    };
  }

  async updateDefaultCommission(
    dto: UpdateDefaultCommissionDto,
    user: AuthUser,
  ) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can change the default commission');
    }
    const rate = Number(dto.defaultCommissionPercent);
    try {
      assertValidRatePercent(rate);
    } catch {
      throw new BadRequestException('Commission rate must be between 0 and 100');
    }

    const before = await this.ensureSettings();
    const updated = await this.prisma.platformSettings.update({
      where: { id: 'default' },
      data: {
        defaultCommissionPercent: new Prisma.Decimal(roundMoney(rate).toFixed(2)),
        commissionsConfigured: true,
      },
    });
    await this.audit.record({
      entityType: 'PlatformSettings',
      entityId: 'default',
      action: 'DEFAULT_COMMISSION_UPDATED',
      actorUserId: user.sub,
      actorRole: user.role,
      before: {
        defaultCommissionPercent: Number(before.defaultCommissionPercent),
      },
      after: {
        defaultCommissionPercent: Number(updated.defaultCommissionPercent),
      },
    });
    return {
      defaultCommissionPercent: Number(updated.defaultCommissionPercent),
      commissionsConfigured: updated.commissionsConfigured,
    };
  }

  async listAgreements(user: AuthUser, supplierId?: string) {
    if (user.role === UserRole.CUSTOMER) {
      throw new ForbiddenException('Customers cannot view commission agreements');
    }
    let filterSupplierId = supplierId;
    if (user.role === UserRole.SUPPLIER) {
      if (!user.supplierId) {
        throw new ForbiddenException('Supplier account is not linked');
      }
      filterSupplierId = user.supplierId;
    }
    const rows = await this.prisma.supplierCommissionAgreement.findMany({
      where: filterSupplierId ? { supplierId: filterSupplierId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { supplier: { select: { id: true, name: true } } },
    });
    return rows.map((row) => this.toAgreementResponse(row));
  }

  async propose(dto: ProposeAgreementDto, user: AuthUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPPLIER) {
      throw new ForbiddenException('Only admins or suppliers can propose rates');
    }
    const rate = Number(dto.ratePercent);
    try {
      assertValidRatePercent(rate);
    } catch {
      throw new BadRequestException('Commission rate must be between 0 and 100');
    }

    let supplierId = dto.supplierId;
    if (user.role === UserRole.SUPPLIER) {
      if (!user.supplierId) {
        throw new ForbiddenException('Supplier account is not linked');
      }
      supplierId = user.supplierId;
    }
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const created = await this.prisma.supplierCommissionAgreement.create({
      data: {
        supplierId,
        proposedRatePercent: new Prisma.Decimal(roundMoney(rate).toFixed(2)),
        status: CommissionAgreementStatus.PROPOSED,
        proposedByRole: user.role,
        proposedByUserId: user.sub,
        notes: dto.notes?.trim() || null,
      },
      include: { supplier: { select: { id: true, name: true } } },
    });
    await this.audit.record({
      entityType: 'SupplierCommissionAgreement',
      entityId: created.id,
      action: 'AGREEMENT_PROPOSED',
      actorUserId: user.sub,
      actorRole: user.role,
      after: this.toAgreementResponse(created),
    });
    return this.toAgreementResponse(created);
  }

  async counter(id: string, dto: CounterAgreementDto, user: AuthUser) {
    const agreement = await this.requireAgreement(id);
    this.assertCanActOnAgreement(agreement, user);

    if (
      agreement.status !== CommissionAgreementStatus.PROPOSED &&
      agreement.status !== CommissionAgreementStatus.COUNTERED &&
      agreement.status !== CommissionAgreementStatus.APPROVED
    ) {
      throw new BadRequestException(
        `Cannot counter an agreement in status ${agreement.status}`,
      );
    }

    const rate = Number(dto.ratePercent);
    try {
      assertValidRatePercent(rate);
    } catch {
      throw new BadRequestException('Commission rate must be between 0 and 100');
    }

    const before = this.toAgreementResponse(agreement);
    const updated = await this.prisma.supplierCommissionAgreement.update({
      where: { id },
      data: {
        counterRatePercent: new Prisma.Decimal(roundMoney(rate).toFixed(2)),
        status: CommissionAgreementStatus.COUNTERED,
        // Counter resets approval/acceptance — admin must re-approve.
        approvedByUserId: null,
        acceptedByUserId: null,
        effectiveRatePercent: null,
        notes: dto.notes?.trim() || agreement.notes,
      },
      include: { supplier: { select: { id: true, name: true } } },
    });
    await this.audit.record({
      entityType: 'SupplierCommissionAgreement',
      entityId: id,
      action: 'AGREEMENT_COUNTERED',
      actorUserId: user.sub,
      actorRole: user.role,
      before,
      after: this.toAgreementResponse(updated),
    });
    return this.toAgreementResponse(updated);
  }

  /** Admin-only approval before supplier acceptance can activate. */
  async approve(id: string, user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can approve commission rates');
    }
    const agreement = await this.requireAgreement(id);
    if (
      agreement.status !== CommissionAgreementStatus.PROPOSED &&
      agreement.status !== CommissionAgreementStatus.COUNTERED
    ) {
      throw new BadRequestException(
        `Cannot approve an agreement in status ${agreement.status}`,
      );
    }
    const rate = Number(
      agreement.counterRatePercent ?? agreement.proposedRatePercent,
    );
    const before = this.toAgreementResponse(agreement);
    const updated = await this.prisma.supplierCommissionAgreement.update({
      where: { id },
      data: {
        status: CommissionAgreementStatus.APPROVED,
        approvedByUserId: user.sub,
        effectiveRatePercent: new Prisma.Decimal(roundMoney(rate).toFixed(2)),
      },
      include: { supplier: { select: { id: true, name: true } } },
    });
    await this.audit.record({
      entityType: 'SupplierCommissionAgreement',
      entityId: id,
      action: 'AGREEMENT_APPROVED',
      actorUserId: user.sub,
      actorRole: user.role,
      before,
      after: this.toAgreementResponse(updated),
    });
    return this.toAgreementResponse(updated);
  }

  /** Supplier acceptance activates an admin-approved agreement. */
  async accept(id: string, user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER) {
      throw new ForbiddenException('Only suppliers can accept commission agreements');
    }
    if (!user.supplierId) {
      throw new ForbiddenException('Supplier account is not linked');
    }
    const agreement = await this.requireAgreement(id);
    if (agreement.supplierId !== user.supplierId) {
      throw new ForbiddenException('Cannot accept another supplier agreement');
    }
    if (agreement.status !== CommissionAgreementStatus.APPROVED) {
      throw new BadRequestException(
        'Agreement must be admin-approved before supplier acceptance',
      );
    }
    if (agreement.effectiveRatePercent == null) {
      throw new BadRequestException('Approved agreement is missing an effective rate');
    }

    const before = this.toAgreementResponse(agreement);
    const now = new Date();
    const activated = await this.prisma.$transaction(async (tx) => {
      await tx.supplierCommissionAgreement.updateMany({
        where: {
          supplierId: agreement.supplierId,
          status: CommissionAgreementStatus.ACTIVE,
          id: { not: id },
        },
        data: {
          status: CommissionAgreementStatus.SUPERSEDED,
          effectiveTo: now,
        },
      });
      return tx.supplierCommissionAgreement.update({
        where: { id },
        data: {
          status: CommissionAgreementStatus.ACTIVE,
          acceptedByUserId: user.sub,
          effectiveFrom: now,
          effectiveTo: null,
        },
        include: { supplier: { select: { id: true, name: true } } },
      });
    });

    await this.audit.record({
      entityType: 'SupplierCommissionAgreement',
      entityId: id,
      action: 'AGREEMENT_ACTIVATED',
      actorUserId: user.sub,
      actorRole: user.role,
      before,
      after: this.toAgreementResponse(activated),
    });
    return this.toAgreementResponse(activated);
  }

  async reject(id: string, user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can reject commission agreements');
    }
    const agreement = await this.requireAgreement(id);
    if (
      agreement.status === CommissionAgreementStatus.ACTIVE ||
      agreement.status === CommissionAgreementStatus.SUPERSEDED ||
      agreement.status === CommissionAgreementStatus.REJECTED
    ) {
      throw new BadRequestException(
        `Cannot reject an agreement in status ${agreement.status}`,
      );
    }
    const before = this.toAgreementResponse(agreement);
    const updated = await this.prisma.supplierCommissionAgreement.update({
      where: { id },
      data: { status: CommissionAgreementStatus.REJECTED },
      include: { supplier: { select: { id: true, name: true } } },
    });
    await this.audit.record({
      entityType: 'SupplierCommissionAgreement',
      entityId: id,
      action: 'AGREEMENT_REJECTED',
      actorUserId: user.sub,
      actorRole: user.role,
      before,
      after: this.toAgreementResponse(updated),
    });
    return this.toAgreementResponse(updated);
  }

  async listAudit(entityType: string, entityId: string, user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can view commission audit logs');
    }
    const rows = await this.audit.listForEntity(entityType, entityId);
    return rows.map((row) => ({
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      action: row.action,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      before: row.beforeJson,
      after: row.afterJson,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Resolve active agreement rate for a supplier, else platform default.
   * No historical backfill — only used for new snapshots.
   */
  async resolveRateForSupplier(supplierId: string, at = new Date()) {
    const active = await this.prisma.supplierCommissionAgreement.findFirst({
      where: {
        supplierId,
        status: CommissionAgreementStatus.ACTIVE,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (active?.effectiveRatePercent != null) {
      return {
        ratePercent: Number(active.effectiveRatePercent),
        agreementId: active.id,
      };
    }
    const settings = await this.ensureSettings();
    return {
      ratePercent: Number(settings.defaultCommissionPercent),
      agreementId: null as string | null,
    };
  }

  /**
   * Create immutable commission snapshots for order lines.
   * Idempotent: existing orderItemId snapshots are left unchanged (duplicate-safe).
   */
  async createSnapshotsForOrder(params: {
    orderId: string;
    paymentMode: string;
    isDemo: boolean;
    initialStatus: CommissionRecognitionStatus;
  }) {
    const order = await this.prisma.order.findUnique({
      where: { id: params.orderId },
      include: {
        items: { include: { commission: true } },
      },
    });
    if (!order) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;
    const now = new Date();

    for (const item of order.items) {
      if (item.commission) {
        skipped += 1;
        continue;
      }
      const resolved = await this.resolveRateForSupplier(item.supplierId, now);
      const values = buildSnapshotValues({
        unitPrice: Number(item.unitPrice),
        quantity: item.quantity,
        ratePercent: resolved.ratePercent,
      });
      const status = params.initialStatus;
      await this.prisma.orderItemCommission.create({
        data: {
          orderItemId: item.id,
          agreementId: resolved.agreementId,
          ratePercent: new Prisma.Decimal(values.ratePercent.toFixed(2)),
          commissionBase: new Prisma.Decimal(values.commissionBase.toFixed(2)),
          commissionAmount: new Prisma.Decimal(
            values.commissionAmount.toFixed(2),
          ),
          status,
          paymentMode: params.paymentMode,
          isDemo: params.isDemo,
          recognizedAt:
            status === CommissionRecognitionStatus.RECOGNIZED ||
            status === CommissionRecognitionStatus.SETTLEABLE
              ? now
              : null,
          settleableAt:
            status === CommissionRecognitionStatus.SETTLEABLE ? now : null,
        },
      });
      created += 1;
    }
    return { created, skipped };
  }

  /**
   * COD: PENDING → RECOGNIZED/SETTLEABLE when item delivered and payment confirmed.
   * Card (non-demo): RECOGNIZED → SETTLEABLE on delivery.
   * Demo: never becomes SETTLEABLE (not a real financial transaction).
   */
  async advanceRecognitionForItem(orderItemId: string) {
    const item = await this.prisma.orderItem.findUnique({
      where: { id: orderItemId },
      include: { commission: true, order: true },
    });
    if (!item?.commission) return null;
    const snap = item.commission;
    if (snap.isDemo) {
      // Demo snapshots stay non-settleable.
      if (
        snap.status === CommissionRecognitionStatus.PENDING &&
        item.order.paymentStatus === PaymentStatus.PAID
      ) {
        return this.prisma.orderItemCommission.update({
          where: { id: snap.id },
          data: {
            status: CommissionRecognitionStatus.RECOGNIZED,
            recognizedAt: new Date(),
          },
        });
      }
      return snap;
    }

    const delivered = item.status === OrderStatus.DELIVERED;
    const paid = item.order.paymentStatus === PaymentStatus.PAID;
    const now = new Date();

    if (snap.status === CommissionRecognitionStatus.SETTLEABLE) {
      return snap;
    }

    if (delivered && paid) {
      return this.prisma.orderItemCommission.update({
        where: { id: snap.id },
        data: {
          status: CommissionRecognitionStatus.SETTLEABLE,
          recognizedAt: snap.recognizedAt ?? now,
          settleableAt: now,
        },
      });
    }

    if (
      snap.status === CommissionRecognitionStatus.PENDING &&
      paid &&
      !delivered
    ) {
      return this.prisma.orderItemCommission.update({
        where: { id: snap.id },
        data: {
          status: CommissionRecognitionStatus.RECOGNIZED,
          recognizedAt: now,
        },
      });
    }

    return snap;
  }

  /**
   * Admin rollup: pending / settleable / total commission per supplier.
   * Real totals exclude demo. Demo totals are returned separately (non-financial).
   */
  async listAdminSupplierTotals(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only Winger admins can view supplier commission totals');
    }

    const suppliers = await this.prisma.supplier.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const rows = await this.prisma.orderItemCommission.findMany({
      select: {
        commissionAmount: true,
        status: true,
        isDemo: true,
        orderItem: { select: { supplierId: true } },
      },
    });

    type Bucket = {
      pending: number;
      settleable: number;
      recognized: number;
      lineCount: number;
      demoTotal: number;
      demoLineCount: number;
    };
    const emptyBucket = (): Bucket => ({
      pending: 0,
      settleable: 0,
      recognized: 0,
      lineCount: 0,
      demoTotal: 0,
      demoLineCount: 0,
    });

    const bySupplier = new Map<string, Bucket>();
    for (const supplier of suppliers) {
      bySupplier.set(supplier.id, emptyBucket());
    }
    for (const row of rows) {
      const supplierId = row.orderItem.supplierId;
      const bucket = bySupplier.get(supplierId) ?? emptyBucket();
      const amount = Number(row.commissionAmount);
      if (row.isDemo) {
        bucket.demoTotal += amount;
        bucket.demoLineCount += 1;
      } else {
        bucket.lineCount += 1;
        if (row.status === CommissionRecognitionStatus.SETTLEABLE) {
          bucket.settleable += amount;
        } else if (row.status === CommissionRecognitionStatus.RECOGNIZED) {
          bucket.recognized += amount;
        } else {
          bucket.pending += amount;
        }
      }
      bySupplier.set(supplierId, bucket);
    }

    const defaultSettings = await this.ensureSettings();
    const defaultRate = Number(defaultSettings.defaultCommissionPercent);

    const suppliersOut = [];
    for (const supplier of suppliers) {
      const totals = bySupplier.get(supplier.id)!;
      const rate = await this.resolveRateForSupplier(supplier.id);
      const total = totals.pending + totals.recognized + totals.settleable;
      suppliersOut.push({
        supplierId: supplier.id,
        supplierName: supplier.name,
        activeRatePercent: rate.ratePercent,
        usingDefaultRate: rate.agreementId == null,
        pendingCommission: roundMoney(totals.pending),
        recognizedCommission: roundMoney(totals.recognized),
        settleableCommission: roundMoney(totals.settleable),
        totalCommission: roundMoney(total),
        lineCount: totals.lineCount,
        demoCommission: roundMoney(totals.demoTotal),
        demoLineCount: totals.demoLineCount,
      });
    }

    const platformPending = roundMoney(
      suppliersOut.reduce((sum, row) => sum + row.pendingCommission, 0),
    );
    const platformRecognized = roundMoney(
      suppliersOut.reduce((sum, row) => sum + row.recognizedCommission, 0),
    );
    const platformSettleable = roundMoney(
      suppliersOut.reduce((sum, row) => sum + row.settleableCommission, 0),
    );
    const platformDemo = roundMoney(
      suppliersOut.reduce((sum, row) => sum + row.demoCommission, 0),
    );

    return {
      defaultCommissionPercent: defaultRate,
      excludesDemo: true,
      totals: {
        pendingCommission: platformPending,
        recognizedCommission: platformRecognized,
        settleableCommission: platformSettleable,
        totalCommission: roundMoney(
          platformPending + platformRecognized + platformSettleable,
        ),
        demoCommission: platformDemo,
        demoLineCount: suppliersOut.reduce(
          (sum, row) => sum + row.demoLineCount,
          0,
        ),
      },
      suppliers: suppliersOut,
    };
  }

  async listSupplierCommissionSummary(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const rows = await this.prisma.orderItemCommission.findMany({
      where: {
        orderItem: { supplierId: user.supplierId },
        isDemo: false,
      },
      include: {
        orderItem: {
          select: {
            productName: true,
            order: { select: { displayId: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const settleable = rows
      .filter((r) => r.status === CommissionRecognitionStatus.SETTLEABLE)
      .reduce((sum, r) => sum + Number(r.commissionAmount), 0);
    const pending = rows
      .filter((r) => r.status !== CommissionRecognitionStatus.SETTLEABLE)
      .reduce((sum, r) => sum + Number(r.commissionAmount), 0);
    const rate = await this.resolveRateForSupplier(user.supplierId);
    return {
      activeRatePercent: rate.ratePercent,
      agreementId: rate.agreementId,
      settleableCommission: roundMoney(settleable),
      pendingCommission: roundMoney(pending),
      lines: rows.map((r) => ({
        id: r.id,
        orderId: r.orderItem.order.displayId,
        productName: r.orderItem.productName,
        ratePercent: Number(r.ratePercent),
        commissionBase: Number(r.commissionBase),
        commissionAmount: Number(r.commissionAmount),
        status: r.status,
        isDemo: r.isDemo,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  private async ensureSettings() {
    return this.prisma.platformSettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        defaultCommissionPercent: new Prisma.Decimal(10),
      },
      update: {},
    });
  }

  private async requireAgreement(id: string) {
    const agreement = await this.prisma.supplierCommissionAgreement.findUnique({
      where: { id },
      include: { supplier: { select: { id: true, name: true } } },
    });
    if (!agreement) throw new NotFoundException('Agreement not found');
    return agreement;
  }

  private assertCanActOnAgreement(
    agreement: { supplierId: string },
    user: AuthUser,
  ) {
    if (user.role === UserRole.ADMIN) return;
    if (user.role === UserRole.SUPPLIER && user.supplierId === agreement.supplierId) {
      return;
    }
    throw new ForbiddenException('Cannot modify this commission agreement');
  }

  private toAgreementResponse(row: {
    id: string;
    supplierId: string;
    proposedRatePercent: Prisma.Decimal;
    counterRatePercent: Prisma.Decimal | null;
    effectiveRatePercent: Prisma.Decimal | null;
    status: CommissionAgreementStatus;
    proposedByRole: UserRole;
    proposedByUserId: string;
    approvedByUserId: string | null;
    acceptedByUserId: string | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    notes: string | null;
    createdAt: Date;
    updatedAt: Date;
    supplier?: { id: string; name: string };
  }) {
    return {
      id: row.id,
      supplierId: row.supplierId,
      supplierName: row.supplier?.name ?? null,
      proposedRatePercent: Number(row.proposedRatePercent),
      counterRatePercent:
        row.counterRatePercent != null ? Number(row.counterRatePercent) : null,
      effectiveRatePercent:
        row.effectiveRatePercent != null
          ? Number(row.effectiveRatePercent)
          : null,
      status: row.status,
      proposedByRole: row.proposedByRole,
      proposedByUserId: row.proposedByUserId,
      approvedByUserId: row.approvedByUserId,
      acceptedByUserId: row.acceptedByUserId,
      effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
