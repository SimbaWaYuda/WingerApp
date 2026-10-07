import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  CommissionAgreementStatus,
  CommissionRecognitionStatus,
  OrderStatus,
  PaymentStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from './audit.service';
import { CommissionsService } from './commissions.service';

function admin(): AuthUser {
  return {
    sub: 'admin-1',
    email: 'admin@winger.example',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

function supplier(supplierId = 'sup-1'): AuthUser {
  return {
    sub: 'supplier-user-1',
    email: 'supplier@winger.example',
    name: 'Supplier',
    role: UserRole.SUPPLIER,
    supplierId,
  };
}

describe('CommissionsService', () => {
  let service: CommissionsService;
  let prisma: any;
  let audit: { record: jest.Mock; listForEntity: jest.Mock };

  beforeEach(() => {
    prisma = {
      platformSettings: {
        upsert: jest.fn(),
        update: jest.fn(),
      },
      supplier: { findUnique: jest.fn() },
      supplierCommissionAgreement: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      order: { findUnique: jest.fn() },
      orderItem: { findUnique: jest.fn() },
      orderItemCommission: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    audit = {
      record: jest.fn().mockResolvedValue({}),
      listForEntity: jest.fn().mockResolvedValue([]),
    };
    service = new CommissionsService(prisma, audit as unknown as AuditService);
  });

  describe('updateDefaultCommission', () => {
    it('allows admin to set 10% default', async () => {
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 12,
      });
      prisma.platformSettings.update.mockResolvedValue({
        defaultCommissionPercent: 10,
        commissionsConfigured: true,
      });
      const result = await service.updateDefaultCommission(
        { defaultCommissionPercent: 10 },
        admin(),
      );
      expect(result.defaultCommissionPercent).toBe(10);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'DEFAULT_COMMISSION_UPDATED' }),
      );
    });

    it('forbids non-admins', async () => {
      await expect(
        service.updateDefaultCommission({ defaultCommissionPercent: 10 }, supplier()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('agreement approval and acceptance', () => {
    const baseAgreement = {
      id: 'agr-1',
      supplierId: 'sup-1',
      proposedRatePercent: 8,
      counterRatePercent: null,
      effectiveRatePercent: null,
      status: CommissionAgreementStatus.PROPOSED,
      proposedByRole: UserRole.ADMIN,
      proposedByUserId: 'admin-1',
      approvedByUserId: null,
      acceptedByUserId: null,
      effectiveFrom: null,
      effectiveTo: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      supplier: { id: 'sup-1', name: 'Acme' },
    };

    it('admin approves then supplier accepts to activate', async () => {
      prisma.supplierCommissionAgreement.findUnique.mockResolvedValue(baseAgreement);
      prisma.supplierCommissionAgreement.update.mockResolvedValue({
        ...baseAgreement,
        status: CommissionAgreementStatus.APPROVED,
        approvedByUserId: 'admin-1',
        effectiveRatePercent: 8,
      });

      const approved = await service.approve('agr-1', admin());
      expect(approved.status).toBe(CommissionAgreementStatus.APPROVED);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AGREEMENT_APPROVED' }),
      );

      prisma.supplierCommissionAgreement.findUnique.mockResolvedValue({
        ...baseAgreement,
        status: CommissionAgreementStatus.APPROVED,
        effectiveRatePercent: 8,
        approvedByUserId: 'admin-1',
      });
      prisma.supplierCommissionAgreement.updateMany.mockResolvedValue({ count: 0 });
      prisma.supplierCommissionAgreement.update.mockResolvedValue({
        ...baseAgreement,
        status: CommissionAgreementStatus.ACTIVE,
        effectiveRatePercent: 8,
        acceptedByUserId: 'supplier-user-1',
        effectiveFrom: new Date(),
      });

      const active = await service.accept('agr-1', supplier());
      expect(active.status).toBe(CommissionAgreementStatus.ACTIVE);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'AGREEMENT_ACTIVATED' }),
      );
    });

    it('rejects supplier acceptance before admin approval', async () => {
      prisma.supplierCommissionAgreement.findUnique.mockResolvedValue(baseAgreement);
      await expect(service.accept('agr-1', supplier())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('forbids non-admin approval', async () => {
      prisma.supplierCommissionAgreement.findUnique.mockResolvedValue(baseAgreement);
      await expect(service.approve('agr-1', supplier())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('createSnapshotsForOrder duplicate processing', () => {
    it('skips lines that already have a snapshot', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord-1',
        items: [
          {
            id: 'item-1',
            supplierId: 'sup-1',
            unitPrice: 100,
            quantity: 1,
            commission: { id: 'existing' },
          },
          {
            id: 'item-2',
            supplierId: 'sup-1',
            unitPrice: 50,
            quantity: 2,
            commission: null,
          },
        ],
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      prisma.orderItemCommission.create.mockResolvedValue({});

      const result = await service.createSnapshotsForOrder({
        orderId: 'ord-1',
        paymentMode: 'cod',
        isDemo: false,
        initialStatus: CommissionRecognitionStatus.PENDING,
      });
      expect(result).toEqual({ created: 1, skipped: 1 });
      expect(prisma.orderItemCommission.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listAdminSupplierTotals', () => {
    it('aggregates pending/settleable totals per supplier and excludes demo', async () => {
      prisma.supplier = {
        findMany: jest.fn().mockResolvedValue([
          { id: 'sup-1', name: 'Acme' },
          { id: 'sup-2', name: 'Beta' },
        ]),
      };
      prisma.orderItemCommission.findMany.mockResolvedValue([
        {
          commissionAmount: 10,
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          orderItem: { supplierId: 'sup-1' },
        },
        {
          commissionAmount: 5,
          status: CommissionRecognitionStatus.SETTLEABLE,
          isDemo: false,
          orderItem: { supplierId: 'sup-1' },
        },
        {
          commissionAmount: 3,
          status: CommissionRecognitionStatus.RECOGNIZED,
          isDemo: false,
          orderItem: { supplierId: 'sup-2' },
        },
        {
          commissionAmount: 99,
          status: CommissionRecognitionStatus.RECOGNIZED,
          isDemo: true,
          orderItem: { supplierId: 'sup-1' },
        },
      ]);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);

      const result = await service.listAdminSupplierTotals(admin());
      expect(result.excludesDemo).toBe(true);
      expect(result.totals.totalCommission).toBe(18);
      expect(result.totals.demoCommission).toBe(99);
      expect(result.suppliers[0]).toMatchObject({
        supplierId: 'sup-1',
        pendingCommission: 10,
        settleableCommission: 5,
        totalCommission: 15,
        lineCount: 2,
        demoCommission: 99,
      });
      expect(result.suppliers[1]).toMatchObject({
        supplierId: 'sup-2',
        recognizedCommission: 3,
        totalCommission: 3,
        lineCount: 1,
        demoCommission: 0,
      });
    });

    it('forbids non-admins', async () => {
      await expect(service.listAdminSupplierTotals(supplier())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('COD status transitions', () => {
    it('moves PENDING to SETTLEABLE when delivered and paid', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          recognizedAt: null,
        },
        order: { paymentStatus: PaymentStatus.PAID, paymentMode: 'cod' },
      });
      prisma.orderItemCommission.update.mockImplementation(async ({ data }: any) => ({
        id: 'c1',
        ...data,
      }));

      const updated = await service.advanceRecognitionForItem('item-1');
      expect(updated?.status).toBe(CommissionRecognitionStatus.SETTLEABLE);
    });

    it('never marks demo commissions SETTLEABLE', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: true,
          recognizedAt: null,
        },
        order: { paymentStatus: PaymentStatus.PAID, paymentMode: 'demo' },
      });
      prisma.orderItemCommission.update.mockImplementation(async ({ data }: any) => ({
        id: 'c1',
        ...data,
      }));

      const updated = await service.advanceRecognitionForItem('item-1');
      expect(updated?.status).toBe(CommissionRecognitionStatus.RECOGNIZED);
      expect(updated?.status).not.toBe(CommissionRecognitionStatus.SETTLEABLE);
    });

    it('does not revive CLAWED_BACK commissions on delivery', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.CLAWED_BACK,
          isDemo: false,
          recognizedAt: new Date(),
        },
        order: { paymentStatus: PaymentStatus.PAID, paymentMode: 'demo' },
      });

      const updated = await service.advanceRecognitionForItem('item-1');
      expect(updated?.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });
  });

  describe('clawbackForOrderItem', () => {
    it('marks commission CLAWED_BACK and writes audit', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.SETTLEABLE,
          commissionAmount: 12.5,
          isDemo: false,
        },
      });
      prisma.orderItemCommission.update.mockResolvedValue({
        id: 'c1',
        status: CommissionRecognitionStatus.CLAWED_BACK,
        commissionAmount: 12.5,
      });

      const result = await service.clawbackForOrderItem({
        orderItemId: 'item-1',
        actor: admin(),
        returnRequestId: 'ret-1',
      });

      expect(result.clawedBack).toBe(true);
      expect(prisma.orderItemCommission.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: CommissionRecognitionStatus.CLAWED_BACK },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'OrderItemCommission',
          action: 'COMMISSION_CLAWED_BACK',
          entityId: 'c1',
        }),
      );
    });

    it('is idempotent when already clawed back', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.CLAWED_BACK,
          commissionAmount: 12.5,
        },
      });

      const result = await service.clawbackForOrderItem({
        orderItemId: 'item-1',
        actor: admin(),
      });

      expect(result.clawedBack).toBe(false);
      expect(result.reason).toBe('already_clawed_back');
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });
  });
});
