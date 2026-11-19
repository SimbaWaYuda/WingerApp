import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  ReturnRefundStatus,
  ReturnRequestStatus,
  UserRole,
} from '@prisma/client';
import { OrdersService } from './orders.service';

/**
 * The mock applies `where`, so list and overview results follow the supplier
 * filter. It does not apply `select` or `include`: every row still carries
 * payment-intent, reconcile, parent-total, customer, and other-supplier
 * fields. Response assertions prove the serializer. Call-argument assertions
 * prove the query. Neither proves the other.
 */

const RETURN_KEYS = [
  'createdAt',
  'customerName',
  'id',
  'notes',
  'orderId',
  'orderItemId',
  'paymentMode',
  'productName',
  'quantity',
  'reason',
  'refundNote',
  'refundStatus',
  'refundedAt',
  'status',
  'supplierName',
].sort();

const SECRETS = [
  'pi_mixed_secret',
  'pi_atlas_secret',
  'cust-1',
  'cust-2',
  'amina@example.com',
  'atlas-buyer@example.com',
  '555-0100',
  '555-0199',
  '1 Market Street',
  '9 Other Road',
  '400000',
  'idem-mixed',
  'worker-secret',
  'refund-drive-unclaimed',
  'abandon-secret',
  'PU-OWN-A',
  'PU-OTHER-B',
  'CR-OWN-A',
  'CR-OTHER-B',
  'Driver A',
  'Driver B',
  'ord-mixed',
  'ord-atlas',
];

function supplier(supplierId: string) {
  return {
    sub: `user-${supplierId}`,
    email: `${supplierId}@example.com`,
    name: supplierId,
    role: UserRole.SUPPLIER,
    supplierId,
  };
}

function unlinkedSupplier() {
  return {
    sub: 'user-unlinked',
    email: 'unlinked@example.com',
    name: 'Unlinked',
    role: UserRole.SUPPLIER,
  };
}

function admin() {
  return {
    sub: 'user-admin',
    email: 'admin@example.com',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

function orderShell(input: {
  id: string;
  displayId: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  addressLine: string;
  paymentIntent: string;
}) {
  return {
    id: input.id,
    displayId: input.displayId,
    customerId: input.customerId,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    addressLine: input.addressLine,
    paymentMode: 'test',
    stripePaymentIntentId: input.paymentIntent,
    stripeChargeAttemptAt: '2026-01-01T00:00:00.000Z',
    checkoutIdempotencyKey: 'idem-mixed',
    paymentReconcileLeaseOwner: 'worker-secret',
    paymentReconcileNextAt: '2026-01-02T00:00:00.000Z',
    paymentAmount: 400000,
    subtotal: 130,
    taxAmount: 10,
    deliveryFee: 8,
    total: 148,
  };
}

function returnRow(input: {
  id: string;
  createdAt: string;
  status: ReturnRequestStatus;
  refundStatus: ReturnRefundStatus;
  supplierId: string;
  supplierName: string;
  productName: string;
  orderItemId: string;
  pickupCode: string;
  trackingCode: string;
  driverName: string;
  order: ReturnType<typeof orderShell>;
}) {
  return {
    id: input.id,
    orderId: input.order.id,
    orderItemId: input.orderItemId,
    customerId: input.order.customerId,
    reason: 'damaged',
    notes: 'Cracked lid',
    quantity: 1,
    status: input.status,
    refundStatus: input.refundStatus,
    refundNote: 'internal refund note',
    refundedAt: null,
    refundDrive: 'refund-drive-unclaimed',
    refundAbandonRequestedAt: 'abandon-secret',
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.createdAt),
    order: input.order,
    orderItem: {
      id: input.orderItemId,
      productName: input.productName,
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      pickupCode: input.pickupCode,
      trackingCode: input.trackingCode,
      driverName: input.driverName,
      driverPhone: '555-0188',
      status: 'DELIVERED',
      lineTotal: 40,
    },
  };
}

function fixtureRows() {
  const kijaniOrder = orderShell({
    id: 'ord-mixed',
    displayId: 'WG-MIXED',
    customerId: 'cust-1',
    customerName: 'Amina Example',
    customerEmail: 'amina@example.com',
    customerPhone: '555-0100',
    addressLine: '1 Market Street',
    paymentIntent: 'pi_mixed_secret',
  });
  const atlasOrder = orderShell({
    id: 'ord-atlas',
    displayId: 'WG-ATLAS',
    customerId: 'cust-2',
    customerName: 'Other Buyer',
    customerEmail: 'atlas-buyer@example.com',
    customerPhone: '555-0199',
    addressLine: '9 Other Road',
    paymentIntent: 'pi_atlas_secret',
  });
  return [
    returnRow({
      id: 'ret-a',
      createdAt: '2026-02-01T00:00:00.000Z',
      status: ReturnRequestStatus.REQUESTED,
      refundStatus: ReturnRefundStatus.NONE,
      supplierId: 'sup-a',
      supplierName: 'Kijani Fixture',
      productName: 'Kijani Kettle',
      orderItemId: 'line-a',
      pickupCode: 'PU-OWN-A',
      trackingCode: 'CR-OWN-A',
      driverName: 'Driver A',
      order: kijaniOrder,
    }),
    returnRow({
      id: 'ret-a2',
      createdAt: '2026-02-02T00:00:00.000Z',
      status: ReturnRequestStatus.APPROVED,
      refundStatus: ReturnRefundStatus.PENDING,
      supplierId: 'sup-a',
      supplierName: 'Kijani Fixture',
      productName: 'Kijani Kettle',
      orderItemId: 'line-a2',
      pickupCode: 'PU-OWN-A',
      trackingCode: 'CR-OWN-A',
      driverName: 'Driver A',
      order: kijaniOrder,
    }),
    returnRow({
      id: 'ret-b',
      createdAt: '2026-02-03T00:00:00.000Z',
      status: ReturnRequestStatus.IN_REVIEW,
      refundStatus: ReturnRefundStatus.NONE,
      supplierId: 'sup-b',
      supplierName: 'Atlas Fixture',
      productName: 'Atlas Lamp',
      orderItemId: 'line-b',
      pickupCode: 'PU-OTHER-B',
      trackingCode: 'CR-OTHER-B',
      driverName: 'Driver B',
      order: atlasOrder,
    }),
    returnRow({
      id: 'ret-b2',
      createdAt: '2026-01-15T00:00:00.000Z',
      status: ReturnRequestStatus.APPROVED,
      refundStatus: ReturnRefundStatus.ISSUED,
      supplierId: 'sup-b',
      supplierName: 'Atlas Fixture',
      productName: 'Atlas Lamp',
      orderItemId: 'line-b2',
      pickupCode: 'PU-OTHER-B',
      trackingCode: 'CR-OTHER-B',
      driverName: 'Driver B',
      order: atlasOrder,
    }),
  ];
}

function matchesWhere(
  row: ReturnType<typeof returnRow>,
  where?: {
    orderItem?: { supplierId?: string };
    refundStatus?: ReturnRefundStatus;
    status?: { in?: ReturnRequestStatus[] };
  },
) {
  if (!where) return true;
  if (
    where.orderItem?.supplierId &&
    row.orderItem.supplierId !== where.orderItem.supplierId
  ) {
    return false;
  }
  if (where.refundStatus && row.refundStatus !== where.refundStatus) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  return true;
}

function harness() {
  const store = new Map(fixtureRows().map((row) => [row.id, row]));
  const refund = jest.fn();
  const clawback = jest.fn();
  const reserve = jest.fn();
  const prisma = {
    returnRequest: {
      findMany: jest.fn(async (args?: { where?: Parameters<typeof matchesWhere>[1] }) =>
        [...store.values()]
          .filter((row) => matchesWhere(row, args?.where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => structuredClone(row)),
      ),
      groupBy: jest.fn(
        async (args: {
          by: Array<'status' | 'refundStatus'>;
          where?: Parameters<typeof matchesWhere>[1];
        }) => {
          const key = args.by[0];
          const counts = new Map<string, number>();
          for (const row of store.values()) {
            if (!matchesWhere(row, args.where)) continue;
            counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
          }
          return [...counts.entries()].map(([value, count]) => ({
            [key]: value,
            _count: { _all: count },
          }));
        },
      ),
      findUnique: jest.fn(async (args: { where: { id: string } }) => {
        const row = store.get(args.where.id);
        return row ? structuredClone(row) : null;
      }),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.get(args.where.id);
          if (!row) return null;
          Object.assign(row, args.data);
          return structuredClone(row);
        },
      ),
    },
  };
  const service = new OrdersService(
    prisma as never,
    {
      advanceRecognitionForItem: jest.fn(),
      clawbackForOrderItem: clawback,
    } as never,
    { refundCardCharge: refund } as never,
    { onSupplierShipped: jest.fn() } as never,
    { notifyReturnStatusChange: jest.fn() } as never,
    {} as never,
    { record: jest.fn(async () => undefined) } as never,
    { reverseIfTransferred: jest.fn(), transferIfSettleable: jest.fn() } as never,
    {} as never,
    { reserveReturnClawback: reserve, applyReturnClawback: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, refund, clawback, reserve };
}

function expectSecretsAbsent(body: string) {
  for (const secret of SECRETS) {
    expect(body).not.toContain(secret);
  }
}

describe('supplier returns response isolation', () => {
  it('rejects an unlinked supplier before querying the returns inbox', async () => {
    const { service, prisma } = harness();

    await expect(service.listReturnsInbox(unlinkedSupplier())).rejects.toThrow(
      new ForbiddenException('Supplier account is not linked'),
    );

    expect(prisma.returnRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.returnRequest.groupBy).not.toHaveBeenCalled();
    expect(prisma.returnRequest.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unlinked supplier before querying the returns overview', async () => {
    const { service, prisma } = harness();

    await expect(service.listReturnsOverview(unlinkedSupplier())).rejects.toThrow(
      new ForbiddenException('Supplier account is not linked'),
    );

    expect(prisma.returnRequest.groupBy).not.toHaveBeenCalled();
    expect(prisma.returnRequest.findMany).not.toHaveBeenCalled();
    expect(prisma.returnRequest.findUnique).not.toHaveBeenCalled();
  });

  it('filters the inbox query by the authenticated supplier', async () => {
    const { service, prisma } = harness();

    await service.listReturnsInbox(supplier('sup-a'));

    expect(prisma.returnRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderItem: { supplierId: 'sup-a' } },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          order: {
            select: { displayId: true, customerName: true, paymentMode: true },
          },
          orderItem: {
            select: { productName: true, supplierName: true, supplierId: true },
          },
        },
      }),
    );
  });

  it('returns only the supplier inbox rows and omits payment and internal keys', async () => {
    const { service } = harness();

    const result = await service.listReturnsInbox(supplier('sup-a'));
    const body = JSON.stringify(result);

    expect(result.map((row) => row.id)).toEqual(['ret-a2', 'ret-a']);
    expect(result.map((row) => row.productName)).toEqual([
      'Kijani Kettle',
      'Kijani Kettle',
    ]);
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Atlas Fixture');
    expect(body).not.toContain('Other Buyer');
    for (const row of result) {
      expect(Object.keys(row).sort()).toEqual(RETURN_KEYS);
      expect(row.customerName).toBe('Amina Example');
      expect(row.paymentMode).toBe('test');
      expect(row.orderId).toBe('WG-MIXED');
      expect(row.supplierName).toBe('Kijani Fixture');
      expect(row).not.toHaveProperty('stripePaymentIntentId');
      expect(row).not.toHaveProperty('customerId');
      expect(row).not.toHaveProperty('supplierId');
      expect(row).not.toHaveProperty('refundDrive');
      expect(row).not.toHaveProperty('refundAbandonRequestedAt');
      expect(row).not.toHaveProperty('subtotal');
      expect(row).not.toHaveProperty('total');
      expect(row).not.toHaveProperty('paymentAmount');
    }
    expectSecretsAbsent(body);
  });

  it('scopes every overview query to the authenticated supplier', async () => {
    const { service, prisma } = harness();

    await service.listReturnsOverview(supplier('sup-a'));

    const supplierScope = { orderItem: { supplierId: 'sup-a' } };
    expect(prisma.returnRequest.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ by: ['status'], where: supplierScope }),
    );
    expect(prisma.returnRequest.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ by: ['refundStatus'], where: supplierScope }),
    );
    expect(prisma.returnRequest.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          ...supplierScope,
          refundStatus: ReturnRefundStatus.PENDING,
          status: {
            in: [ReturnRequestStatus.APPROVED, ReturnRequestStatus.CLOSED],
          },
        },
      }),
    );
    expect(prisma.returnRequest.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          ...supplierScope,
          status: {
            in: [ReturnRequestStatus.REQUESTED, ReturnRequestStatus.IN_REVIEW],
          },
        },
      }),
    );
  });

  it('returns supplier overview counts without another supplier identity', async () => {
    const { service } = harness();

    const result = await service.listReturnsOverview(supplier('sup-a'));
    const body = JSON.stringify(result);

    expect(Object.keys(result).sort()).toEqual(
      [
        'approvedReturns',
        'byRefundStatus',
        'byStatus',
        'openReturns',
        'pendingRefunds',
        'refundsIssued',
        'rejectedReturns',
        'scope',
        'suppliers',
      ].sort(),
    );
    expect(result.scope).toBe('supplier');
    expect(result.suppliers).toEqual([]);
    expect(result.openReturns).toBe(1);
    expect(result.pendingRefunds).toBe(1);
    expect(result.refundsIssued).toBe(0);
    expect(result.approvedReturns).toBe(1);
    expect(result.rejectedReturns).toBe(0);
    expect(result.byStatus).toEqual({
      REQUESTED: 1,
      APPROVED: 1,
    });
    expect(result.byRefundStatus).toEqual({
      NONE: 1,
      PENDING: 1,
    });
    expect(body).not.toContain('Atlas');
    expect(body).not.toContain('sup-b');
    expect(body).not.toContain('Other Buyer');
    expectSecretsAbsent(body);
  });

  it('keeps the admin overview on the platform query', async () => {
    const { service, prisma } = harness();

    await service.listReturnsOverview(admin());

    expect(prisma.returnRequest.groupBy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ by: ['status'], where: {} }),
    );
    expect(prisma.returnRequest.groupBy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ by: ['refundStatus'], where: {} }),
    );
    expect(prisma.returnRequest.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          refundStatus: ReturnRefundStatus.PENDING,
          status: {
            in: [ReturnRequestStatus.APPROVED, ReturnRequestStatus.CLOSED],
          },
        },
      }),
    );
  });

  it('keeps the admin supplier breakdown', async () => {
    const { service } = harness();

    const result = await service.listReturnsOverview(admin());
    const body = JSON.stringify(result);

    expect(result.scope).toBe('platform');
    expect(result.openReturns).toBe(2);
    expect(result.pendingRefunds).toBe(1);
    expect(result.refundsIssued).toBe(1);
    expect(result.approvedReturns).toBe(2);
    expect(result.rejectedReturns).toBe(0);
    expect(result.byStatus).toEqual({
      REQUESTED: 1,
      APPROVED: 2,
      IN_REVIEW: 1,
    });
    expect(result.suppliers).toEqual([
      {
        supplierId: 'sup-a',
        supplierName: 'Kijani Fixture',
        openReturns: 1,
        pendingRefunds: 1,
      },
      {
        supplierId: 'sup-b',
        supplierName: 'Atlas Fixture',
        openReturns: 1,
        pendingRefunds: 0,
      },
    ]);
    expect(body).not.toContain('pi_mixed_secret');
    expect(body).not.toContain('pi_atlas_secret');
    expect(body).not.toContain('Amina Example');
    expect(body).not.toContain('Atlas Lamp');
  });

  it('rejects another supplier before loading payment fields', async () => {
    const { service, prisma, refund, clawback, reserve } = harness();

    await expect(
      service.updateReturnRequest(
        'ret-a',
        { status: ReturnRequestStatus.IN_REVIEW },
        supplier('sup-b'),
      ),
    ).rejects.toThrow('Cannot review another supplier return');

    const calls = prisma.returnRequest.findUnique.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toEqual({
      where: { id: 'ret-a' },
      select: {
        id: true,
        orderItem: { select: { supplierId: true } },
      },
    });
    expect(JSON.stringify(calls)).not.toContain('stripePaymentIntentId');
    expect(JSON.stringify(calls)).not.toContain('paymentAmount');
    expect(JSON.stringify(calls)).not.toContain('subtotal');
    expect(JSON.stringify(calls)).not.toContain('total');
    expect(prisma.returnRequest.update).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
    expect(clawback).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('reports a missing return from the ownership query', async () => {
    const { service, prisma } = harness();

    await expect(
      service.updateReturnRequest(
        'ret-missing',
        { status: ReturnRequestStatus.IN_REVIEW },
        supplier('sup-a'),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.returnRequest.findUnique.mock.calls).toHaveLength(1);
    expect(JSON.stringify(prisma.returnRequest.findUnique.mock.calls)).not.toContain(
      'stripePaymentIntentId',
    );
    expect(prisma.returnRequest.update).not.toHaveBeenCalled();
  });

  it('loads payment fields only after the supplier ownership gate', async () => {
    const { service, prisma } = harness();

    await service.updateReturnRequest(
      'ret-a',
      { status: ReturnRequestStatus.IN_REVIEW },
      supplier('sup-a'),
    );

    const calls = prisma.returnRequest.findUnique.mock.calls;
    expect(calls[0][0]).toEqual({
      where: { id: 'ret-a' },
      select: {
        id: true,
        orderItem: { select: { supplierId: true } },
      },
    });
    expect(calls[1][0]).toEqual({
      where: { id: 'ret-a' },
      include: {
        order: {
          select: {
            id: true,
            displayId: true,
            paymentMode: true,
            stripePaymentIntentId: true,
            paymentAmount: true,
            subtotal: true,
            total: true,
          },
        },
        orderItem: true,
      },
    });
    const findOrder = prisma.returnRequest.findUnique.mock.invocationCallOrder;
    const updateOrder = prisma.returnRequest.update.mock.invocationCallOrder;
    expect(findOrder[0]).toBeLessThan(findOrder[1]);
    expect(findOrder[1]).toBeLessThan(updateOrder[0]);
  });

  it('loads payment fields for an admin only after the return is found', async () => {
    const { service, prisma } = harness();

    await service.updateReturnRequest(
      'ret-a',
      { status: ReturnRequestStatus.IN_REVIEW },
      admin(),
    );

    const calls = prisma.returnRequest.findUnique.mock.calls;
    expect(calls[0][0]).toEqual({
      where: { id: 'ret-a' },
      select: {
        id: true,
        orderItem: { select: { supplierId: true } },
      },
    });
    expect(calls[1][0]).toEqual({
      where: { id: 'ret-a' },
      include: {
        order: {
          select: {
            id: true,
            displayId: true,
            paymentMode: true,
            stripePaymentIntentId: true,
            paymentAmount: true,
            subtotal: true,
            total: true,
          },
        },
        orderItem: true,
      },
    });
    expect(prisma.returnRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ret-a' },
        data: { status: ReturnRequestStatus.IN_REVIEW },
      }),
    );
  });

  it('omits payment fields from an admin return decision', async () => {
    const { service } = harness();

    const result = await service.updateReturnRequest(
      'ret-a',
      { status: ReturnRequestStatus.IN_REVIEW },
      admin(),
    );

    expect(Object.keys(result).sort()).toEqual(RETURN_KEYS);
    expect(result.customerName).toBe('Amina Example');
    expect(result.status).toBe(ReturnRequestStatus.IN_REVIEW);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result).not.toHaveProperty('subtotal');
    expect(result).not.toHaveProperty('total');
    expectSecretsAbsent(JSON.stringify(result));
  });

  it('loads the decision response from the narrow return query', async () => {
    const { service, prisma } = harness();

    await service.updateReturnRequest(
      'ret-a',
      { status: ReturnRequestStatus.IN_REVIEW },
      supplier('sup-a'),
    );

    expect(prisma.returnRequest.findUnique).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'ret-a' },
        include: {
          order: {
            select: { displayId: true, customerName: true, paymentMode: true },
          },
          orderItem: {
            select: { productName: true, supplierName: true },
          },
        },
      }),
    );
    expect(prisma.returnRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ret-a' },
        data: { status: ReturnRequestStatus.IN_REVIEW },
      }),
    );
  });

  it('returns only the owning supplier return fields', async () => {
    const { service, refund, clawback, reserve } = harness();

    const result = await service.updateReturnRequest(
      'ret-a',
      { status: ReturnRequestStatus.IN_REVIEW },
      supplier('sup-a'),
    );
    const body = JSON.stringify(result);

    expect(Object.keys(result).sort()).toEqual(RETURN_KEYS);
    expect(result.id).toBe('ret-a');
    expect(result.orderId).toBe('WG-MIXED');
    expect(result.orderItemId).toBe('line-a');
    expect(result.productName).toBe('Kijani Kettle');
    expect(result.supplierName).toBe('Kijani Fixture');
    expect(result.customerName).toBe('Amina Example');
    expect(result.paymentMode).toBe('test');
    expect(result.status).toBe(ReturnRequestStatus.IN_REVIEW);
    expect(result.refundStatus).toBe(ReturnRefundStatus.NONE);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result).not.toHaveProperty('customerId');
    expect(result).not.toHaveProperty('supplierId');
    expect(result).not.toHaveProperty('refundDrive');
    expect(result).not.toHaveProperty('subtotal');
    expect(result).not.toHaveProperty('total');
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Atlas Fixture');
    expectSecretsAbsent(body);
    expect(refund).not.toHaveBeenCalled();
    expect(clawback).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
