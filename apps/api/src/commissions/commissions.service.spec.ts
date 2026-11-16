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
import { cardCheckoutMode } from '../orders/checkout-mode';
import { AuditService } from './audit.service';
import { CommissionLedgerService } from './commission-ledger.service';
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
        createMany: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      cashCollection: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'c1' }]),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    audit = {
      record: jest.fn().mockResolvedValue({}),
      listForEntity: jest.fn().mockResolvedValue([]),
    };
    const ledger = {
      restoreAfterClawback: jest.fn().mockResolvedValue({ restored: true }),
    };
    service = new CommissionsService(
      prisma,
      audit as unknown as AuditService,
      ledger as unknown as CommissionLedgerService,
    );
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
        currency: 'USD',
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
      prisma.orderItemCommission.createMany.mockResolvedValue({ count: 1 });
      prisma.orderItemCommission.findMany.mockResolvedValue([
        {
          orderItemId: 'item-1',
          ratePercent: 10,
          commissionBase: 100,
          commissionAmount: 10,
          currency: 'USD',
          paymentMode: 'cod',
          isDemo: false,
        },
        {
          orderItemId: 'item-2',
          ratePercent: 10,
          commissionBase: 100,
          commissionAmount: 10,
          currency: 'USD',
          paymentMode: 'cod',
          isDemo: false,
        },
      ]);

      const result = await service.createSnapshotsForOrder({
        orderId: 'ord-1',
        paymentMode: 'cod',
        isDemo: false,
        initialStatus: CommissionRecognitionStatus.PENDING,
      });
      expect(result).toEqual({ created: 1, skipped: 1 });
      expect(prisma.orderItemCommission.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skipDuplicates: true,
          data: [
            expect.objectContaining({
              orderItemId: 'item-2',
              paymentMode: 'cod',
              isDemo: false,
            }),
          ],
        }),
      );
      expect(prisma.orderItemCommission.create).not.toHaveBeenCalled();
    });

    it('treats createMany skipDuplicates as idempotent success and does not overwrite', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord-1',
        currency: 'USD',
        items: [
          {
            id: 'item-1',
            supplierId: 'sup-1',
            unitPrice: 58.99,
            quantity: 1,
            commission: null,
          },
        ],
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      // Concurrent winner already inserted — skipDuplicates inserts 0.
      prisma.orderItemCommission.createMany.mockResolvedValue({ count: 0 });
      prisma.orderItemCommission.findMany.mockResolvedValue([
        {
          orderItemId: 'item-1',
          ratePercent: 10,
          commissionBase: 58.99,
          commissionAmount: 5.9,
          currency: 'USD',
          paymentMode: 'test',
          isDemo: true,
        },
      ]);

      const result = await service.createSnapshotsForOrder({
        orderId: 'ord-1',
        paymentMode: 'test',
        isDemo: true,
        initialStatus: CommissionRecognitionStatus.RECOGNIZED,
      });
      expect(result).toEqual({ created: 0, skipped: 1 });
    });

    it('creates snapshots for every missing line in one createMany', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord-1',
        currency: 'USD',
        items: [
          {
            id: 'item-a',
            supplierId: 'sup-1',
            unitPrice: 10,
            quantity: 1,
            commission: null,
          },
          {
            id: 'item-b',
            supplierId: 'sup-1',
            unitPrice: 20,
            quantity: 2,
            commission: null,
          },
        ],
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      prisma.orderItemCommission.createMany.mockResolvedValue({ count: 2 });
      prisma.orderItemCommission.findMany.mockResolvedValue([
        {
          orderItemId: 'item-a',
          ratePercent: 10,
          commissionBase: 10,
          commissionAmount: 1,
          currency: 'USD',
          paymentMode: 'live',
          isDemo: false,
        },
        {
          orderItemId: 'item-b',
          ratePercent: 10,
          commissionBase: 40,
          commissionAmount: 4,
          currency: 'USD',
          paymentMode: 'live',
          isDemo: false,
        },
      ]);

      const result = await service.createSnapshotsForOrder({
        orderId: 'ord-1',
        paymentMode: 'live',
        isDemo: false,
        initialStatus: CommissionRecognitionStatus.RECOGNIZED,
      });
      expect(result).toEqual({ created: 2, skipped: 0 });
      expect(prisma.orderItemCommission.createMany.mock.calls[0][0].data).toHaveLength(
        2,
      );
    });

    it('propagates genuine createMany database errors', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord-1',
        currency: 'USD',
        items: [
          {
            id: 'item-1',
            supplierId: 'sup-1',
            unitPrice: 10,
            quantity: 1,
            commission: null,
          },
        ],
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      prisma.orderItemCommission.createMany.mockRejectedValue(
        new Error('connection reset'),
      );

      await expect(
        service.createSnapshotsForOrder({
          orderId: 'ord-1',
          paymentMode: 'test',
          isDemo: true,
          initialStatus: CommissionRecognitionStatus.RECOGNIZED,
        }),
      ).rejects.toThrow(/connection reset/i);
    });

    it('fails closed when persisted snapshot immutable fields do not match', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'ord-1',
        currency: 'USD',
        items: [
          {
            id: 'item-1',
            supplierId: 'sup-1',
            unitPrice: 10,
            quantity: 1,
            commission: null,
          },
        ],
      });
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });
      prisma.orderItemCommission.createMany.mockResolvedValue({ count: 0 });
      prisma.orderItemCommission.findMany.mockResolvedValue([
        {
          orderItemId: 'item-1',
          ratePercent: 10,
          commissionBase: 10,
          commissionAmount: 99,
          currency: 'USD',
          paymentMode: 'test',
          isDemo: true,
        },
      ]);

      await expect(
        service.createSnapshotsForOrder({
          orderId: 'ord-1',
          paymentMode: 'test',
          isDemo: true,
          initialStatus: CommissionRecognitionStatus.RECOGNIZED,
        }),
      ).rejects.toThrow(/does not match expected immutable fields/i);
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
          orderItem: {
            supplierId: 'sup-1',
            status: OrderStatus.DELIVERED,
            order: {
              paymentStatus: PaymentStatus.PAID,
              paymentMode: 'card',
              cashCollections: [],
            },
          },
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
      expect(result.cardCheckout).toBe(cardCheckoutMode(process.env.STRIPE_SECRET_KEY));
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

    it('sums every commission row, not only the latest 50', async () => {
      const rows = Array.from({ length: 51 }, (_, index) => ({
        id: `c-${index}`,
        commissionAmount: 1,
        ratePercent: 10,
        commissionBase: 10,
        status:
          index === 0
            ? CommissionRecognitionStatus.SETTLEABLE
            : CommissionRecognitionStatus.PENDING,
        isDemo: false,
        createdAt: new Date(Date.UTC(2026, 0, index + 1)),
        orderItem: {
          productName: `Product ${index}`,
          status: index === 0 ? OrderStatus.DELIVERED : OrderStatus.PROCESSING,
          supplierId: 'sup-1',
          order: {
            displayId: `WG-${index}`,
            paymentStatus: PaymentStatus.PAID,
            paymentMode: 'card',
            cashCollections: [],
          },
        },
      }));
      prisma.orderItemCommission.findMany.mockResolvedValue(rows);
      prisma.supplierCommissionAgreement.findFirst.mockResolvedValue(null);
      prisma.platformSettings.upsert.mockResolvedValue({
        defaultCommissionPercent: 10,
      });

      const result = await service.listSupplierCommissionSummary(supplier());
      expect(result.lines).toHaveLength(50);
      expect(result.pendingCommission).toBe(50);
      expect(result.settleableCommission).toBe(1);
      expect(result.recognizedCommission).toBe(0);
      expect(result.reversedCommission).toBe(0);
      expect(result.commissionWaiting).toBe(1);
      expect(result.cashCommission).toBe(0);
      expect(result.payoutsSent).toEqual([]);
    });
  });

  describe('COD status transitions', () => {
    it('does not settle COD that was delivered without a collection', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        supplierId: 'sup-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          recognizedAt: null,
        },
        order: {
          id: 'ord-1',
          paymentStatus: PaymentStatus.PENDING,
          paymentMode: 'cod',
        },
      });

      const updated = await service.advanceRecognitionForItem('item-1');
      expect(updated?.status).toBe(CommissionRecognitionStatus.PENDING);
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });

    it('settles COD when that supplier collected and the line is delivered', async () => {
      prisma.cashCollection.findUnique.mockResolvedValue({ id: 'col-1', supplierId: 'sup-1' });
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        supplierId: 'sup-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          recognizedAt: null,
        },
        order: {
          id: 'ord-1',
          paymentStatus: PaymentStatus.PENDING,
          paymentMode: 'cod',
        },
      });
      prisma.orderItemCommission.update.mockImplementation(async ({ data }: any) => ({
        id: 'c1',
        ...data,
      }));

      const updated = await service.advanceRecognitionForItem('item-1');
      expect(updated?.status).toBe(CommissionRecognitionStatus.SETTLEABLE);
    });

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

    it('recognises a paid undelivered Lipa line and leaves it there on retry', async () => {
      const item = {
        id: 'item-1',
        supplierId: 'sup-1',
        status: OrderStatus.PROCESSING,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          recognizedAt: null,
        },
        order: {
          id: 'ord-1',
          paymentStatus: PaymentStatus.PAID,
          paymentMode: 'lipa',
        },
      };
      prisma.orderItem.findUnique.mockResolvedValue(item);
      prisma.orderItemCommission.update.mockImplementation(async ({ data }: any) => {
        item.commission = { ...item.commission, ...data };
        return item.commission;
      });

      const first = await service.advanceRecognitionForItem('item-1');
      expect(first?.status).toBe(CommissionRecognitionStatus.RECOGNIZED);
      prisma.orderItemCommission.update.mockClear();
      const second = await service.advanceRecognitionForItem('item-1');
      expect(second?.status).toBe(CommissionRecognitionStatus.RECOGNIZED);
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });

    it('settles a delivered paid card line and does not move a settleable line again', async () => {
      const item = {
        id: 'item-1',
        supplierId: 'sup-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: false,
          recognizedAt: null,
        },
        order: {
          id: 'ord-1',
          paymentStatus: PaymentStatus.PAID,
          paymentMode: 'card',
        },
      };
      prisma.orderItem.findUnique.mockResolvedValue(item);
      prisma.orderItemCommission.update.mockImplementation(async ({ data }: any) => {
        item.commission = { ...item.commission, ...data };
        return item.commission;
      });

      const first = await service.advanceRecognitionForItem('item-1');
      expect(first?.status).toBe(CommissionRecognitionStatus.SETTLEABLE);
      prisma.orderItemCommission.update.mockClear();
      const second = await service.advanceRecognitionForItem('item-1');
      expect(second?.status).toBe(CommissionRecognitionStatus.SETTLEABLE);
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });

    it('never marks a delivered paid demo Lipa line SETTLEABLE', async () => {
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        supplierId: 'sup-1',
        status: OrderStatus.DELIVERED,
        commission: {
          id: 'c1',
          status: CommissionRecognitionStatus.PENDING,
          isDemo: true,
          recognizedAt: null,
        },
        order: {
          id: 'ord-1',
          paymentStatus: PaymentStatus.PAID,
          paymentMode: 'lipa',
        },
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
      const snap = {
        id: 'c1',
        status: CommissionRecognitionStatus.SETTLEABLE,
        commissionAmount: 12.5,
        isDemo: false,
      };
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        commission: snap,
      });
      prisma.orderItemCommission.findUniqueOrThrow.mockResolvedValue(snap);
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
      expect(prisma.$queryRaw).toHaveBeenCalled();
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
      const snap = {
        id: 'c1',
        status: CommissionRecognitionStatus.CLAWED_BACK,
        commissionAmount: 12.5,
      };
      prisma.orderItem.findUnique.mockResolvedValue({
        id: 'item-1',
        commission: snap,
      });
      prisma.orderItemCommission.findUniqueOrThrow.mockResolvedValue(snap);

      const result = await service.clawbackForOrderItem({
        orderItemId: 'item-1',
        actor: admin(),
      });

      expect(result.clawedBack).toBe(false);
      expect(result.reason).toBe('already_clawed_back');
      expect(prisma.orderItemCommission.update).not.toHaveBeenCalled();
    });

    it('uses the caller transaction for eligibility reads when tx is supplied', async () => {
      const snap = {
        id: 'c1',
        status: CommissionRecognitionStatus.SETTLEABLE,
        commissionAmount: 12.5,
      };
      const tx = {
        orderItem: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'item-1',
            commission: snap,
          }),
        },
        orderItemCommission: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(snap),
          update: jest.fn().mockResolvedValue({
            ...snap,
            status: CommissionRecognitionStatus.CLAWED_BACK,
          }),
        },
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'c1' }]),
      };
      const ledger = (service as any).ledger as {
        restoreAfterClawback: jest.Mock;
      };

      const result = await service.clawbackForOrderItem({
        orderItemId: 'item-1',
        actor: admin(),
        tx: tx as never,
      });

      expect(result.clawedBack).toBe(true);
      expect(prisma.orderItem.findUnique).not.toHaveBeenCalled();
      expect(tx.orderItem.findUnique).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(ledger.restoreAfterClawback).toHaveBeenCalledWith(
        tx,
        'c1',
        expect.anything(),
      );
    });
  });
});
