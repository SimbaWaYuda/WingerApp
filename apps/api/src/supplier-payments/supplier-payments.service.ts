import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MobileMoneyNetwork,
  PaymentArrangementPreference,
  SupplierPaymentProfileStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../commissions/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  effectivePaymentArrangement,
  isValidLipaOrTillNumber,
  normalizeLipaOrTillNumber,
} from './payment-arrangement';

export type SubmitPaymentProfileDto = {
  preference: PaymentArrangementPreference | string;
  network?: MobileMoneyNetwork | string;
  merchantName: string;
  lipaOrTillNumber: string;
  businessRegRef?: string;
  tinRef?: string;
  notes?: string;
};

@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getMine(user: AuthUser) {
    const supplierId = this.requireSupplierId(user);
    return this.buildSupplierView(supplierId);
  }

  async submitMine(user: AuthUser, body: SubmitPaymentProfileDto) {
    const supplierId = this.requireSupplierId(user);
    const preference = this.parsePreference(body.preference);
    const network = this.parseNetwork(body.network);
    const merchantName = (body.merchantName ?? '').trim();
    const lipaOrTillNumber = normalizeLipaOrTillNumber(
      body.lipaOrTillNumber ?? '',
    );

    if (!merchantName) {
      throw new BadRequestException('Merchant name is required');
    }
    if (!isValidLipaOrTillNumber(lipaOrTillNumber)) {
      throw new BadRequestException(
        'Lipa / Till number must be 6–20 letters or digits',
      );
    }
    if (preference === PaymentArrangementPreference.SUPPLIER_DIRECT) {
      // Already validated till; keep explicit for clarity.
    }

    const activeApproved = await this.prisma.supplierPaymentProfile.findFirst({
      where: {
        supplierId,
        status: SupplierPaymentProfileStatus.APPROVED,
      },
      orderBy: { version: 'desc' },
    });
    const pending = await this.prisma.supplierPaymentProfile.findFirst({
      where: {
        supplierId,
        status: SupplierPaymentProfileStatus.PENDING_REVIEW,
      },
    });
    if (pending) {
      throw new BadRequestException(
        'A payment profile is already awaiting admin review',
      );
    }

    const latest = await this.prisma.supplierPaymentProfile.findFirst({
      where: { supplierId },
      orderBy: { version: 'desc' },
    });
    const version = (latest?.version ?? 0) + 1;
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierPaymentProfile.create({
        data: {
          supplierId,
          preference,
          network,
          merchantName,
          lipaOrTillNumber,
          businessRegRef: body.businessRegRef?.trim() || null,
          tinRef: body.tinRef?.trim() || null,
          notes: body.notes?.trim() || null,
          status: SupplierPaymentProfileStatus.PENDING_REVIEW,
          version,
          submittedAt: now,
          submittedByUserId: user.sub,
          replacesProfileId: activeApproved?.id ?? null,
        },
      });
      await this.audit.record({
        entityType: 'SupplierPaymentProfile',
        entityId: row.id,
        action: 'SUBMITTED',
        actorUserId: user.sub,
        actorRole: user.role,
        after: this.serialize(row),
        tx,
      });
      return row;
    });

    return this.buildSupplierView(supplierId, created.id);
  }

  async setPreference(user: AuthUser, preferenceRaw: string) {
    const supplierId = this.requireSupplierId(user);
    const preference = this.parsePreference(preferenceRaw);
    const approved = await this.prisma.supplierPaymentProfile.findFirst({
      where: {
        supplierId,
        status: SupplierPaymentProfileStatus.APPROVED,
      },
      orderBy: { version: 'desc' },
    });
    if (!approved) {
      if (preference === PaymentArrangementPreference.SUPPLIER_DIRECT) {
        throw new BadRequestException(
          'Submit and get admin approval for a Lipa / Till number before enabling supplier-direct payments',
        );
      }
      return this.buildSupplierView(supplierId);
    }
    if (approved.preference === preference) {
      return this.buildSupplierView(supplierId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierPaymentProfile.update({
        where: { id: approved.id },
        data: { preference },
      });
      await this.audit.record({
        entityType: 'SupplierPaymentProfile',
        entityId: row.id,
        action:
          preference === PaymentArrangementPreference.SUPPLIER_DIRECT
            ? 'PREFERENCE_SUPPLIER_DIRECT'
            : 'PREFERENCE_WINGER_MANAGED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: this.serialize(approved),
        after: this.serialize(row),
        tx,
      });
      return row;
    });

    return this.buildSupplierView(supplierId, updated.id);
  }

  async listPending(user: AuthUser) {
    this.requireAdmin(user);
    const rows = await this.prisma.supplierPaymentProfile.findMany({
      where: { status: SupplierPaymentProfileStatus.PENDING_REVIEW },
      include: {
        supplier: { select: { id: true, name: true, verificationStatus: true } },
      },
      orderBy: { submittedAt: 'asc' },
    });
    return rows.map((row) => this.serialize(row));
  }

  async listForSupplier(user: AuthUser, supplierId: string) {
    this.requireAdmin(user);
    return this.buildSupplierView(supplierId);
  }

  async approve(user: AuthUser, profileId: string, reviewNote?: string) {
    this.requireAdmin(user);
    const profile = await this.requireProfile(profileId);
    if (profile.status !== SupplierPaymentProfileStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only pending profiles can be approved');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      if (profile.replacesProfileId) {
        await tx.supplierPaymentProfile.update({
          where: { id: profile.replacesProfileId },
          data: { status: SupplierPaymentProfileStatus.SUPERSEDED },
        });
      } else {
        await tx.supplierPaymentProfile.updateMany({
          where: {
            supplierId: profile.supplierId,
            status: SupplierPaymentProfileStatus.APPROVED,
            id: { not: profile.id },
          },
          data: { status: SupplierPaymentProfileStatus.SUPERSEDED },
        });
      }
      const updated = await tx.supplierPaymentProfile.update({
        where: { id: profile.id },
        data: {
          status: SupplierPaymentProfileStatus.APPROVED,
          reviewedAt: now,
          reviewedByUserId: user.sub,
          reviewNote: reviewNote?.trim() || null,
          activeFrom: now,
        },
      });
      await this.audit.record({
        entityType: 'SupplierPaymentProfile',
        entityId: updated.id,
        action: 'APPROVED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: this.serialize(profile),
        after: this.serialize(updated),
        tx,
      });
    });

    return this.buildSupplierView(profile.supplierId, profileId);
  }

  async reject(user: AuthUser, profileId: string, reviewNote?: string) {
    this.requireAdmin(user);
    const profile = await this.requireProfile(profileId);
    if (profile.status !== SupplierPaymentProfileStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only pending profiles can be rejected');
    }
    const note = (reviewNote ?? '').trim();
    if (!note) {
      throw new BadRequestException('A review note is required to reject');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierPaymentProfile.update({
        where: { id: profile.id },
        data: {
          status: SupplierPaymentProfileStatus.REJECTED,
          reviewedAt: new Date(),
          reviewedByUserId: user.sub,
          reviewNote: note,
        },
      });
      await this.audit.record({
        entityType: 'SupplierPaymentProfile',
        entityId: row.id,
        action: 'REJECTED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: this.serialize(profile),
        after: this.serialize(row),
        tx,
      });
      return row;
    });

    return this.buildSupplierView(updated.supplierId, updated.id);
  }

  async suspend(user: AuthUser, profileId: string, reviewNote?: string) {
    this.requireAdmin(user);
    const profile = await this.requireProfile(profileId);
    if (profile.status !== SupplierPaymentProfileStatus.APPROVED) {
      throw new BadRequestException('Only approved profiles can be suspended');
    }
    const note = (reviewNote ?? '').trim();
    if (!note) {
      throw new BadRequestException('A review note is required to suspend');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierPaymentProfile.update({
        where: { id: profile.id },
        data: {
          status: SupplierPaymentProfileStatus.SUSPENDED,
          reviewedAt: new Date(),
          reviewedByUserId: user.sub,
          reviewNote: note,
        },
      });
      await this.audit.record({
        entityType: 'SupplierPaymentProfile',
        entityId: row.id,
        action: 'SUSPENDED',
        actorUserId: user.sub,
        actorRole: user.role,
        before: this.serialize(profile),
        after: this.serialize(row),
        tx,
      });
      return row;
    });

    return this.buildSupplierView(updated.supplierId, updated.id);
  }

  /** Approved Lipa numbers a customer can pay. Unapproved profiles are omitted. */
  async checkoutLipa(supplierIds: string[]) {
    const ids = [
      ...new Set(
        supplierIds
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id.length <= 80),
      ),
    ].slice(0, 20);
    if (ids.length === 0) return { suppliers: [] };

    const profiles = await this.prisma.supplierPaymentProfile.findMany({
      where: {
        supplierId: { in: ids },
        status: SupplierPaymentProfileStatus.APPROVED,
        preference: PaymentArrangementPreference.SUPPLIER_DIRECT,
      },
      include: { supplier: { select: { name: true } } },
      orderBy: { version: 'desc' },
    });
    const latest = new Map<string, (typeof profiles)[number]>();
    for (const row of profiles) {
      if (!latest.has(row.supplierId)) latest.set(row.supplierId, row);
    }
    return {
      suppliers: [...latest.values()].map((row) => ({
        supplierId: row.supplierId,
        supplierName: row.supplier.name,
        merchantName: row.merchantName,
        lipaOrTillNumber: row.lipaOrTillNumber,
        network: row.network,
      })),
    };
  }

  /** Public-safe display fields for an approved direct profile (Phase 2+). */
  customerVisibleInstructions(profile: {
    preference: PaymentArrangementPreference;
    status: SupplierPaymentProfileStatus;
    merchantName: string;
    lipaOrTillNumber: string;
    network: MobileMoneyNetwork;
  }) {
    if (
      effectivePaymentArrangement(profile) !==
      PaymentArrangementPreference.SUPPLIER_DIRECT
    ) {
      return null;
    }
    return {
      merchantName: profile.merchantName,
      lipaOrTillNumber: profile.lipaOrTillNumber,
      network: profile.network,
    };
  }

  private async buildSupplierView(supplierId: string, focusId?: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { id: true, name: true, verificationStatus: true },
    });
    if (!supplier) {
      throw new NotFoundException('Supplier not found');
    }

    const profiles = await this.prisma.supplierPaymentProfile.findMany({
      where: { supplierId },
      orderBy: { version: 'desc' },
    });
    const approved =
      profiles.find((p) => p.status === SupplierPaymentProfileStatus.APPROVED) ??
      null;
    const pending =
      profiles.find(
        (p) => p.status === SupplierPaymentProfileStatus.PENDING_REVIEW,
      ) ?? null;
    const focus =
      (focusId ? profiles.find((p) => p.id === focusId) : null) ??
      pending ??
      approved ??
      profiles[0] ??
      null;

    return {
      supplier,
      effectiveArrangement: effectivePaymentArrangement(approved),
      supplierDirectAvailable: approved
        ? approved.preference === PaymentArrangementPreference.SUPPLIER_DIRECT
        : false,
      approvedProfile: approved ? this.serialize(approved) : null,
      pendingProfile: pending ? this.serialize(pending) : null,
      currentProfile: focus ? this.serialize(focus) : null,
      history: profiles.map((p) => this.serialize(p)),
    };
  }

  private async requireProfile(id: string) {
    const profile = await this.prisma.supplierPaymentProfile.findUnique({
      where: { id },
    });
    if (!profile) {
      throw new NotFoundException('Payment profile not found');
    }
    return profile;
  }

  private requireSupplierId(user: AuthUser): string {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    return user.supplierId;
  }

  private requireAdmin(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin only');
    }
  }

  private parsePreference(
    value: PaymentArrangementPreference | string,
  ): PaymentArrangementPreference {
    const raw = `${value ?? ''}`.trim().toUpperCase();
    if (raw === PaymentArrangementPreference.SUPPLIER_DIRECT) {
      return PaymentArrangementPreference.SUPPLIER_DIRECT;
    }
    if (raw === PaymentArrangementPreference.WINGER_MANAGED || raw === '') {
      return PaymentArrangementPreference.WINGER_MANAGED;
    }
    throw new BadRequestException('Invalid payment preference');
  }

  private parseNetwork(
    value?: MobileMoneyNetwork | string,
  ): MobileMoneyNetwork {
    const raw = `${value ?? MobileMoneyNetwork.ALL_NETWORKS}`
      .trim()
      .toUpperCase();
    const allowed = Object.values(MobileMoneyNetwork) as string[];
    if (!allowed.includes(raw)) {
      throw new BadRequestException('Invalid mobile-money network');
    }
    return raw as MobileMoneyNetwork;
  }

  private serialize(
    row: Record<string, unknown> & {
      id: string;
      supplierId: string;
      preference: PaymentArrangementPreference;
      status: SupplierPaymentProfileStatus;
      network: MobileMoneyNetwork;
      merchantName: string;
      lipaOrTillNumber: string;
      version: number;
    },
  ) {
    return {
      id: row.id,
      supplierId: row.supplierId,
      preference: row.preference,
      network: row.network,
      merchantName: row.merchantName,
      lipaOrTillNumber: row.lipaOrTillNumber,
      businessRegRef: row.businessRegRef ?? null,
      tinRef: row.tinRef ?? null,
      notes: row.notes ?? null,
      status: row.status,
      version: row.version,
      submittedAt: row.submittedAt ?? null,
      submittedByUserId: row.submittedByUserId ?? null,
      reviewedAt: row.reviewedAt ?? null,
      reviewedByUserId: row.reviewedByUserId ?? null,
      reviewNote: row.reviewNote ?? null,
      activeFrom: row.activeFrom ?? null,
      replacesProfileId: row.replacesProfileId ?? null,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      supplier: row.supplier ?? undefined,
      effectiveArrangement: effectivePaymentArrangement(row),
    };
  }
}
