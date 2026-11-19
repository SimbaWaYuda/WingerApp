import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';

function dec(value: number) {
  return new Prisma.Decimal(value.toFixed(2));
}

function user(role: UserRole, supplierId?: string) {
  return {
    sub: role === UserRole.CUSTOMER ? 'cust-1' : `user-${supplierId ?? role}`,
    email: 'person@example.com',
    name: 'Test User',
    role,
    supplierId,
  };
}

function line(input: {
  id: string;
  supplierId: string;
  supplierName: string;
  productName: string;
  lineTotal: number;
  pickupCode: string;
  trackingCode: string;
  driverName: string;
  commissionAmount: number;
}) {
  return {
    id: input.id,
    productId: `product-${input.id}`,
    productName: input.productName,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    unitPrice: dec(input.lineTotal),
    quantity: 1,
    lineTotal: dec(input.lineTotal),
    status: OrderStatus.DELIVERED,
    trackingCode: input.trackingCode,
    pickupCode: input.pickupCode,
    carrier: 'courier',
    courierName: `${input.supplierName} Courier`,
    variantId: `variant-${input.id}`,
    variantColor: input.supplierId === 'sup-a' ? 'Green' : 'Brass',
    variantSize: input.supplierId === 'sup-a' ? 'M' : 'Large',
    courierBooking: {
      reference: input.trackingCode,
      status: 'booked',
      courierName: `${input.supplierName} Courier`,
      driverName: input.driverName,
      driverPhone: input.supplierId === 'sup-a' ? '555-0101' : '555-0199',
      plateNumber: input.supplierId === 'sup-a' ? 'AAA 1' : 'ZZZ 9',
      fee: dec(3),
      trackingUrl: `https://example.test/${input.id}`,
    },
    commission: {
      ratePercent: dec(10),
      commissionBase: dec(input.lineTotal),
      commissionAmount: dec(input.commissionAmount),
      status: 'PENDING',
      isDemo: false,
    },
  };
}

function bucket(
  supplierId: string,
  merchandise: number,
  deliveryFee: number,
  merchandiseTax: number,
  deliveryTax: number,
  paymentMerchandise: number,
) {
  return {
    supplierId,
    merchandise: dec(merchandise),
    deliveryFee: dec(deliveryFee),
    merchandiseTax: dec(merchandiseTax),
    deliveryTax: dec(deliveryTax),
    paymentMerchandise: dec(paymentMerchandise),
    paymentDelivery: dec(5),
    paymentTax: dec(2),
  };
}

function mixedOrder() {
  return {
    id: 'ord-mixed',
    displayId: 'WG-MIXED',
    customerId: 'cust-1',
    customerName: 'Amina Example',
    customerEmail: 'amina@example.com',
    customerPhone: '555-0100',
    customer: { phone: '555-0100' },
    status: OrderStatus.DELIVERED,
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: 'card',
    paymentMode: 'test',
    stripePaymentIntentId: 'pi_mixed_secret',
    currency: 'USD',
    settlementCurrency: 'USD',
    displayCurrency: 'TZS',
    displayTotal: dec(400000),
    paymentCurrency: 'TZS',
    paymentAmount: dec(400000),
    fxRate: dec(2500),
    subtotal: dec(130),
    taxAmount: dec(10),
    deliveryFee: dec(8),
    total: dec(148),
    addressLine: '1 Market Street',
    city: 'Dar es Salaam',
    createdAt: new Date('2026-01-15T00:00:00.000Z'),
    items: [
      line({
        id: 'line-a',
        supplierId: 'sup-a',
        supplierName: 'Kijani Fixture',
        productName: 'Kijani Kettle',
        lineTotal: 40,
        pickupCode: 'PU-OWN-A',
        trackingCode: 'CR-OWN-A',
        driverName: 'Driver A',
        commissionAmount: 4,
      }),
      line({
        id: 'line-b',
        supplierId: 'sup-b',
        supplierName: 'Atlas Fixture',
        productName: 'Atlas Lamp',
        lineTotal: 90,
        pickupCode: 'PU-OTHER-B',
        trackingCode: 'CR-OTHER-B',
        driverName: 'Driver B',
        commissionAmount: 9,
      }),
    ],
    shipments: [
      bucket('sup-a', 40, 2, 1, 0.5, 100),
      bucket('sup-b', 90, 6, 8, 0.5, 300),
    ],
  };
}

function singleOrder() {
  const order = mixedOrder();
  order.id = 'ord-single';
  order.displayId = 'WG-SINGLE';
  order.stripePaymentIntentId = 'pi_single_secret';
  order.items = [order.items[0]];
  order.shipments = [order.shipments[0]];
  order.subtotal = dec(40);
  order.taxAmount = dec(1.5);
  order.deliveryFee = dec(2);
  order.total = dec(43.5);
  order.paymentAmount = dec(107);
  order.displayTotal = dec(107);
  return order;
}

function embeddedReturn(input: {
  id: string;
  orderItemId: string;
  supplierId: string;
  supplierName: string;
  productName: string;
  notes: string;
  createdAt: string;
  paymentIntent: string;
}) {
  return {
    id: input.id,
    orderId: 'ord-mixed',
    orderItemId: input.orderItemId,
    reason: 'damaged',
    notes: input.notes,
    quantity: 1,
    status: 'REQUESTED',
    refundStatus: 'NONE',
    refundNote: null,
    refundedAt: null,
    stripePaymentIntentId: input.paymentIntent,
    paymentAmount: 400000,
    subtotal: 130,
    total: 148,
    createdAt: new Date(input.createdAt),
    order: {
      displayId: 'WG-MIXED',
      paymentMode: 'test',
      stripePaymentIntentId: input.paymentIntent,
    },
    orderItem: {
      productName: input.productName,
      supplierName: input.supplierName,
      supplierId: input.supplierId,
    },
  };
}

function sharedDetailReturns() {
  return [
    embeddedReturn({
      id: 'ret-a',
      orderItemId: 'line-a',
      supplierId: 'sup-a',
      supplierName: 'Kijani Fixture',
      productName: 'Kijani Kettle',
      notes: 'kijani return note',
      createdAt: '2026-01-15T00:00:00.000Z',
      paymentIntent: 'pi_detail_a',
    }),
    embeddedReturn({
      id: 'ret-b',
      orderItemId: 'line-b',
      supplierId: 'sup-b',
      supplierName: 'Atlas Fixture',
      productName: 'Atlas Lamp',
      notes: 'atlas return note',
      createdAt: '2026-01-16T00:00:00.000Z',
      paymentIntent: 'pi_detail_b',
    }),
  ];
}

function openService(
  orders: ReturnType<typeof mixedOrder>[],
  returnsOverride?: ReturnType<typeof sharedDetailReturns>,
) {
  const returns = returnsOverride ?? [
    {
      id: 'ret-b',
      orderId: 'ord-mixed',
      orderItemId: 'line-b',
      reason: 'other',
      notes: 'atlas note',
      quantity: 1,
      status: 'REQUESTED',
      refundStatus: 'NONE',
      refundNote: null,
      refundedAt: null,
      createdAt: new Date('2026-01-16T00:00:00.000Z'),
      order: { displayId: 'WG-MIXED', paymentMode: 'test' },
      orderItem: {
        productName: 'Atlas Lamp',
        supplierName: 'Atlas Fixture',
        supplierId: 'sup-b',
      },
    },
  ];
  const prisma = {
    order: {
      findMany: jest.fn(async (_query?: object) => orders),
      findFirst: jest.fn(
        async ({ where }: { where: { OR: Array<{ id?: string; displayId?: string }> } }) => {
          const key = where.OR.find((row) => row.id)?.id ?? where.OR.find((row) => row.displayId)?.displayId;
          return (
            orders.find((order) => order.id === key || order.displayId === key) ?? null
          );
        },
      ),
      findUnique: jest.fn(
        async ({
          where,
          include,
        }: {
          where: { id: string };
          include?: {
            items?: { where?: { supplierId?: string } };
            shipments?: { where?: { supplierId?: string } };
          };
          select?: Record<string, unknown>;
        }) => {
          const order = orders.find((row) => row.id === where.id);
          if (!order) return null;
          const itemSupplierId = include?.items?.where?.supplierId;
          const shipmentSupplierId = include?.shipments?.where?.supplierId;
          return {
            ...order,
            items: itemSupplierId
              ? order.items.filter((item) => item.supplierId === itemSupplierId)
              : order.items,
            shipments: shipmentSupplierId
              ? order.shipments.filter((row) => row.supplierId === shipmentSupplierId)
              : order.shipments,
          };
        },
      ),
    },
    orderItem: {
      findMany: jest.fn(
        async (args?: {
          where?: { orderId?: { in?: string[] }; supplierId?: { not?: string } };
        }) => {
          const notSupplier = args?.where?.supplierId?.not;
          const ids = args?.where?.orderId?.in;
          return orders
            .filter((order) => !ids || ids.includes(order.id))
            .filter((order) =>
              order.items.some(
                (item) => !notSupplier || item.supplierId !== notSupplier,
              ),
            )
            .map((order) => ({ orderId: order.id }));
        },
      ),
    },
    returnRequest: {
      findMany: jest.fn(
        async (args?: {
          where?: { orderId?: string; orderItem?: { supplierId?: string } };
        }) => {
          const supplierId = args?.where?.orderItem?.supplierId;
          const orderId = args?.where?.orderId;
          return returns.filter((row) => {
            if (orderId && row.orderId !== orderId) return false;
            if (supplierId && row.orderItem.supplierId !== supplierId) return false;
            return true;
          });
        },
      ),
    },
    supplierReview: {
      findMany: jest.fn(async () => []),
    },
  };
  const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

function serviceFor(orders: ReturnType<typeof mixedOrder>[]) {
  return openService(orders).service;
}

function unbucketedSharedService() {
  const full = mixedOrder();
  full.shipments = [];
  const prisma = {
    order: {
      findMany: jest.fn(
        async ({
          include,
          select,
        }: {
          include?: { items?: { where?: { supplierId?: string } } };
          select?: { items?: { where?: { supplierId?: string } } };
        }) => {
          const supplierId =
            include?.items?.where?.supplierId ?? select?.items?.where?.supplierId;
          return [
            {
              ...full,
              items: supplierId
                ? full.items.filter((item) => item.supplierId === supplierId)
                : full.items,
              shipments: [],
            },
          ];
        },
      ),
      findFirst: jest.fn(async () => full),
      findUnique: jest.fn(
        async ({
          include,
          select,
        }: {
          include?: { items?: { where?: { supplierId?: string } } };
          select?: { items?: { where?: { supplierId?: string } } };
        }) => {
          const supplierId =
            include?.items?.where?.supplierId ?? select?.items?.where?.supplierId;
          return {
            ...full,
            items: supplierId
              ? full.items.filter((item) => item.supplierId === supplierId)
              : full.items,
            shipments: [],
          };
        },
      ),
    },
    orderItem: {
      findMany: jest.fn(
        async (args?: { where?: { supplierId?: { not?: string } } }) => {
          const notSupplier = args?.where?.supplierId?.not;
          const shared = full.items.some(
            (item) => !notSupplier || item.supplierId !== notSupplier,
          );
          return shared ? [{ orderId: full.id }] : [];
        },
      ),
    },
    returnRequest: { findMany: jest.fn(async () => []) },
    supplierReview: { findMany: jest.fn(async () => []) },
  };
  return { service: serviceFrom(prisma), prisma };
}

function actionHarness(
  itemStatus: OrderStatus = OrderStatus.PROCESSING,
  options?: { singleSupplier?: boolean },
) {
  const order: any = mixedOrder();
  order.paymentMode = 'cod';
  order.paymentStatus = PaymentStatus.PENDING;
  order.items = order.items.map((item: any) => ({
    ...item,
    orderId: order.id,
    status: item.supplierId === 'sup-a' ? itemStatus : item.status,
  }));
  if (options?.singleSupplier) {
    order.items = order.items.filter((item: any) => item.supplierId === 'sup-a');
    order.shipments = order.shipments.filter((row: any) => row.supplierId === 'sup-a');
    order.subtotal = dec(40);
    order.taxAmount = dec(1.5);
    order.deliveryFee = dec(2);
    order.total = dec(43.5);
    order.paymentAmount = dec(107);
    order.displayTotal = dec(107);
  }
  const calls = {
    clawback: jest.fn(async () => ({})),
    refund: jest.fn(),
    collection: jest.fn(async () => ({ id: 'col-1' })),
    courierUpdate: jest.fn(async () => ({})),
    recognition: jest.fn(async () => null),
  };
  let prisma: any;
  prisma = {
    order: {
      findUnique: jest.fn(async () => order),
      findUniqueOrThrow: jest.fn(
        async ({
          include,
        }: {
          include?: { items?: { where?: { supplierId?: string } } };
        }) => {
          const supplierId = include?.items?.where?.supplierId;
          return {
            ...order,
            items: supplierId
              ? order.items.filter((item: any) => item.supplierId === supplierId)
              : order.items,
            shipments: order.shipments,
          };
        },
      ),
      update: jest.fn(async () => order),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    orderItem: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = order.items.find((item: any) => item.id === where.id);
        return row ? { ...row, order } : null;
      }),
      findMany: jest.fn(
        async (args?: { where?: { supplierId?: { not?: string } } }) => {
          const notSupplier = args?.where?.supplierId?.not;
          if (notSupplier) {
            return order.items
              .filter((item: any) => item.supplierId !== notSupplier)
              .map(() => ({ orderId: order.id }));
          }
          return order.items;
        },
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { status?: OrderStatus; pickupCode?: string; trackingCode?: string };
        }) => {
          const row = order.items.find((item: any) => item.id === where.id);
          if (row && data.status) row.status = data.status;
          if (row && data.pickupCode) row.pickupCode = data.pickupCode;
          if (row && data.trackingCode) row.trackingCode = data.trackingCode;
          return row;
        },
      ),
    },
    orderShipment: {
      findMany: jest.fn(async () =>
        order.shipments.map((row: any) => ({
          ...row,
          supplierName: row.supplierId === 'sup-a' ? 'Kijani Fixture' : 'Atlas Fixture',
        })),
      ),
    },
    cashCollection: {
      findMany: jest.fn(async () => []),
      create: calls.collection,
    },
    courierBooking: {
      findUnique: jest.fn(async () => ({
        reference: 'CR-OWN-A',
        status: 'booked',
      })),
      update: calls.courierUpdate,
      updateMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => 0),
    },
    product: { findUnique: jest.fn(async () => null) },
    inventoryLedger: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  return { service: serviceFrom(prisma, calls), prisma, calls, order };
}

function serviceFrom(
  prisma: object,
  calls?: {
    recognition: jest.Mock;
    clawback: jest.Mock;
    refund: jest.Mock;
  },
) {
  return new OrdersService(
    prisma as never,
    {
      advanceRecognitionForItem: calls?.recognition ?? jest.fn(),
      clawbackForOrderItem: calls?.clawback ?? jest.fn(),
    } as never,
    { refundCardCharge: calls?.refund ?? jest.fn() } as never,
    { onSupplierShipped: jest.fn() } as never,
    {} as never,
    {} as never,
    { record: jest.fn(async () => undefined) } as never,
    {
      reverseIfTransferred: jest.fn(async () => undefined),
      transferIfSettleable: jest.fn(),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

function expectSupplierABucket(result: {
  items: Array<{
    id: string;
    pickupCode: string | null;
    courierBooking?: { driverName?: string | null } | null;
  }>;
  subtotal: number;
  tax: number;
  deliveryFee: number;
  total: number;
  paymentAmount: number;
  displayTotal: number | null;
}) {
  const body = JSON.stringify(result);
  expect(result.items.map((item) => item.id)).toEqual(['line-a']);
  expect(result.items[0].pickupCode).toBe('PU-OWN-A');
  expect(result.items[0].courierBooking?.driverName).toBe('Driver A');
  expect(body).not.toContain('Atlas Lamp');
  expect(body).not.toContain('PU-OTHER-B');
  expect(body).not.toContain('Driver B');
  expect(body).not.toContain('pi_mixed_secret');
  expect(body).not.toContain('400000');
  expect(result).not.toHaveProperty('stripePaymentIntentId');
  expect(result.subtotal).toBe(40);
  expect(result.tax).toBe(1.5);
  expect(result.deliveryFee).toBe(2);
  expect(result.total).toBe(43.5);
  expect(result.paymentAmount).toBe(107);
  expect(result.displayTotal).toBeNull();
  expect(result.total).not.toBe(148);
}

function replacementHarness() {
  const source = {
    id: 'line-a',
    orderId: 'ord-mixed',
    supplierId: 'sup-a',
    supplierName: 'Kijani Fixture',
    productId: 'product-line-a',
    quantity: 1,
    status: OrderStatus.RETURNED,
    carrier: 'courier',
    courierName: 'Kijani Courier',
    imageUrl: null,
    variantId: null,
    variantColor: 'Green',
    variantSize: 'M',
    replacedBy: null,
    order: {
      id: 'ord-mixed',
      displayId: 'WG-MIXED',
      customerId: 'cust-1',
      customerName: 'Amina Example',
      customerEmail: 'amina@example.com',
      customerPhone: '555-0100',
      currency: 'USD',
      settlementCurrency: 'USD',
      addressLine: '1 Market Street',
      city: 'Dar es Salaam',
      stripePaymentIntentId: 'pi_parent_secret',
      subtotal: dec(130),
      total: dec(148),
      paymentAmount: dec(400000),
    },
    product: {
      id: 'product-line-a',
      name: 'Kijani Kettle',
      price: dec(40),
      stock: 5,
      imageUrl: null,
      supplierId: 'sup-a',
    },
  };
  const created = {
    id: 'ord-repl',
    displayId: 'WG-REPL',
    customerId: 'cust-1',
    customerName: 'Amina Example',
    customerEmail: 'amina@example.com',
    customerPhone: '555-0100',
    customer: { phone: '555-0100' },
    status: OrderStatus.PROCESSING,
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: 'replacement',
    paymentMode: 'replacement',
    stripePaymentIntentId: null as string | null,
    currency: 'USD',
    settlementCurrency: 'USD',
    paymentCurrency: 'USD',
    paymentAmount: dec(40),
    subtotal: dec(40),
    taxAmount: dec(0),
    deliveryFee: dec(0),
    total: dec(40),
    displayTotal: null,
    addressLine: '1 Market Street',
    city: 'Dar es Salaam',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    items: [
      {
        id: 'line-repl',
        productId: 'product-line-a',
        productName: 'Kijani Kettle',
        supplierId: 'sup-a',
        supplierName: 'Kijani Fixture',
        unitPrice: dec(40),
        quantity: 1,
        lineTotal: dec(40),
        status: OrderStatus.PROCESSING,
        trackingCode: null,
        pickupCode: null,
        carrier: 'courier',
        courierName: 'Kijani Courier',
        commission: null,
        courierBooking: null,
      },
    ],
    shipments: [],
  };
  const tx = {
    order: {
      count: jest.fn(async () => 1),
      create: jest.fn(async () => created),
    },
    product: { update: jest.fn(async () => ({})) },
    inventoryLedger: { create: jest.fn(async () => ({})) },
    returnRequest: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
  const prisma = {
    orderItem: { findUnique: jest.fn(async (_query?: object) => source) },
    $transaction: jest.fn(async (fn: (trx: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { service: serviceFrom(prisma), prisma, tx, source };
}

describe('supplier order data isolation', () => {
  it('returns only supplier A lines and scoped totals on a shared order', async () => {
    const service = serviceFor([mixedOrder()]);
    const result = await service.findOne('WG-MIXED', user(UserRole.SUPPLIER, 'sup-a'));
    const body = JSON.stringify(result);

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'line-a',
        productName: 'Kijani Kettle',
        supplierId: 'sup-a',
        supplierName: 'Kijani Fixture',
        pickupCode: 'PU-OWN-A',
        trackingCode: 'CR-OWN-A',
      }),
    ]);
    expect(result.items[0].courierBooking).toEqual(
      expect.objectContaining({ driverName: 'Driver A', plateNumber: 'AAA 1' }),
    );
    expect(result.items[0].commission).toEqual(
      expect.objectContaining({ commissionAmount: 4 }),
    );
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Atlas Fixture');
    expect(body).not.toContain('PU-OTHER-B');
    expect(body).not.toContain('CR-OTHER-B');
    expect(body).not.toContain('Driver B');
    expect(body).not.toContain('ZZZ 9');
    expect(body).not.toContain('555-0199');
    expect(body).not.toContain('pi_mixed_secret');
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result.subtotal).toBe(40);
    expect(result.deliveryFee).toBe(2);
    expect(result.tax).toBe(1.5);
    expect(result.total).toBe(43.5);
    expect(result.paymentAmount).toBe(107);
    expect(result.displayTotal).toBeNull();
    expect(result.customerPhone).toBe('555-0100');
    expect(result.addressLine).toBe('1 Market Street');
    expect(result.city).toBe('Dar es Salaam');
    expect(result.returnRequests).toEqual([]);
  });

  it('returns only supplier B lines when that supplier opens the same order', async () => {
    const service = serviceFor([mixedOrder()]);
    const result = await service.findOne('ord-mixed', user(UserRole.SUPPLIER, 'sup-b'));
    const body = JSON.stringify(result);

    expect(result.items.map((item) => item.productName)).toEqual(['Atlas Lamp']);
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('PU-OWN-A');
    expect(body).not.toContain('Driver A');
    expect(result.subtotal).toBe(90);
    expect(result.deliveryFee).toBe(6);
    expect(result.tax).toBe(8.5);
    expect(result.total).toBe(104.5);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
  });

  it('scopes the supplier order list and omits the payment intent and combined totals', async () => {
    const service = serviceFor([mixedOrder()]);
    const [result] = await service.list(user(UserRole.SUPPLIER, 'sup-a'));
    const body = JSON.stringify(result);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].supplierId).toBe('sup-a');
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('pi_mixed_secret');
    expect(body).not.toContain('400000');
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result.subtotal).toBe(40);
    expect(result.tax).toBe(1.5);
    expect(result.deliveryFee).toBe(2);
    expect(result.total).toBe(43.5);
    expect(result.total).not.toBe(148);
  });

  it('rejects an unlinked supplier before querying orders', async () => {
    const { service, prisma } = openService([mixedOrder()]);

    await expect(service.list(user(UserRole.SUPPLIER))).rejects.toThrow(
      'Supplier account is missing supplierId',
    );

    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('keeps the full order for the customer and for an admin', async () => {
    const service = serviceFor([mixedOrder()]);
    const customer = await service.findOne('WG-MIXED', user(UserRole.CUSTOMER));
    const admin = await service.findOne('WG-MIXED', user(UserRole.ADMIN));

    expect(customer.items.map((item) => item.productName).sort()).toEqual([
      'Atlas Lamp',
      'Kijani Kettle',
    ]);
    expect(customer.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(customer.subtotal).toBe(130);
    expect(customer.tax).toBe(10);
    expect(customer.deliveryFee).toBe(8);
    expect(customer.total).toBe(148);
    expect(admin.items).toHaveLength(2);
    expect(admin.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(admin.total).toBe(148);
  });

  it('keeps a single-supplier order intact except for the payment intent', async () => {
    const service = serviceFor([singleOrder()]);
    const result = await service.findOne('WG-SINGLE', user(UserRole.SUPPLIER, 'sup-a'));

    expect(result.items).toHaveLength(1);
    expect(result.items[0].pickupCode).toBe('PU-OWN-A');
    expect(result.items[0].courierBooking?.driverName).toBe('Driver A');
    expect(result.subtotal).toBe(40);
    expect(result.tax).toBe(1.5);
    expect(result.deliveryFee).toBe(2);
    expect(result.total).toBe(43.5);
    expect(result.paymentAmount).toBe(107);
    expect(result.displayTotal).toBe(107);
    expect(result.customerPhone).toBe('555-0100');
    expect(result.addressLine).toBe('1 Market Street');
    expect(result).not.toHaveProperty('stripePaymentIntentId');

    const [listed] = await service.list(user(UserRole.SUPPLIER, 'sup-a'));
    expect(listed.items).toHaveLength(1);
    expect(listed.subtotal).toBe(40);
    expect(listed.tax).toBe(1.5);
    expect(listed.deliveryFee).toBe(2);
    expect(listed.total).toBe(43.5);
    expect(listed.paymentAmount).toBe(107);
    expect(listed.displayTotal).toBe(107);
    expect(listed).not.toHaveProperty('stripePaymentIntentId');
  });

  it('still rejects a supplier who has no line and a missing order', async () => {
    const service = serviceFor([mixedOrder()]);
    await expect(
      service.findOne('WG-MIXED', user(UserRole.SUPPLIER, 'sup-c')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.findOne('WG-MISSING', user(UserRole.SUPPLIER, 'sup-a')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes a shared order that has no shipment records', async () => {
    const { service, prisma } = unbucketedSharedService();
    const supplierA = user(UserRole.SUPPLIER, 'sup-a');
    const supplierB = user(UserRole.SUPPLIER, 'sup-b');
    const [listedA] = await service.list(supplierA);
    const [listedB] = await service.list(supplierB);
    const detailA = await service.findOne('WG-MIXED', supplierA);
    const detailB = await service.findOne('WG-MIXED', supplierB);

    for (const result of [listedA, detailA]) {
      const body = JSON.stringify(result);
      expect(result.items.map((item) => item.productName)).toEqual(['Kijani Kettle']);
      expect(body).not.toContain('Atlas Lamp');
      expect(body).not.toContain('pi_mixed_secret');
      expect(result).not.toHaveProperty('stripePaymentIntentId');
      expect(result.subtotal).toBe(40);
      expect(result.tax).toBe(0);
      expect(result.deliveryFee).toBe(0);
      expect(result.total).toBe(40);
      expect(result.paymentAmount).toBe(40);
      expect(result.displayTotal).toBeNull();
      expect(result.total).not.toBe(148);
    }
    for (const result of [listedB, detailB]) {
      const body = JSON.stringify(result);
      expect(result.items.map((item) => item.productName)).toEqual(['Atlas Lamp']);
      expect(body).not.toContain('Kijani Kettle');
      expect(body).not.toContain('pi_mixed_secret');
      expect(result).not.toHaveProperty('stripePaymentIntentId');
      expect(result.subtotal).toBe(90);
      expect(result.tax).toBe(0);
      expect(result.deliveryFee).toBe(0);
      expect(result.total).toBe(90);
      expect(result.paymentAmount).toBe(90);
      expect(result.displayTotal).toBeNull();
    }

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          items: expect.objectContaining({ where: { supplierId: 'sup-a' } }),
          shipments: expect.objectContaining({
            where: { supplierId: 'sup-a' },
          }),
        }),
      }),
    );
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId: { in: ['ord-mixed'] },
          supplierId: { not: 'sup-a' },
        },
        select: { orderId: true },
        distinct: ['orderId'],
      }),
    );
  });

  it('rejects a customer before querying an item action', async () => {
    const { service, prisma } = actionHarness();

    await expect(
      service.updateItemStatus('ord-mixed', 'line-a', { status: OrderStatus.READY_FOR_PICKUP }, user(UserRole.CUSTOMER)),
    ).rejects.toThrow(
      new ForbiddenException('Only suppliers or admins can update items'),
    );

    expect(prisma.orderItem.findUnique).not.toHaveBeenCalled();
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('rejects an unlinked supplier before querying an item action', async () => {
    const { service, prisma } = actionHarness();

    await expect(
      service.updateItemStatus(
        'ord-mixed',
        'line-a',
        { status: OrderStatus.READY_FOR_PICKUP },
        user(UserRole.SUPPLIER),
      ),
    ).rejects.toThrow(new ForbiddenException('Cannot update another supplier item'));

    expect(prisma.orderItem.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects another supplier from the minimal item query', async () => {
    const { service, prisma } = actionHarness();

    await expect(
      service.updateItemStatus(
        'ord-mixed',
        'line-a',
        { status: OrderStatus.READY_FOR_PICKUP },
        user(UserRole.SUPPLIER, 'sup-b'),
      ),
    ).rejects.toThrow(new ForbiddenException('Cannot update another supplier item'));

    expect(prisma.orderItem.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.findUnique).toHaveBeenCalledWith({
      where: { id: 'line-a' },
      select: {
        id: true,
        orderId: true,
        supplierId: true,
        order: { select: { id: true, displayId: true } },
      },
    });
    const gate = JSON.stringify(prisma.orderItem.findUnique.mock.calls[0][0]);
    expect(gate).not.toContain('stripePaymentIntentId');
    expect(gate).not.toContain('paymentAmount');
    expect(gate).not.toContain('subtotal');
    expect(gate).not.toContain('taxAmount');
    expect(gate).not.toContain('deliveryFee');
    expect(gate).not.toContain('"total"');
    expect(prisma.orderItem.findUnique.mock.calls[0][0].include).toBeUndefined();
  });

  it('does not mutate an item when another supplier is rejected', async () => {
    const { service, prisma, calls } = actionHarness();

    await expect(
      service.updateItemStatus(
        'WG-MIXED',
        'line-a',
        { status: OrderStatus.CANCELLED, collectPayment: true },
        user(UserRole.SUPPLIER, 'sup-b'),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.cashCollection.create).not.toHaveBeenCalled();
    expect(prisma.courierBooking.update).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
    expect(calls.refund).not.toHaveBeenCalled();
    expect(calls.clawback).not.toHaveBeenCalled();
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('returns the supplier-scoped reload after an owner status update', async () => {
    const { service } = actionHarness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expectSupplierABucket(result);
    expect(result.items[0].status).toBe(OrderStatus.READY_FOR_PICKUP);
  });

  it('loads the parent order only after the owner gate', async () => {
    const { service, prisma } = actionHarness();

    await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    const calls = prisma.orderItem.findUnique.mock.calls;
    expect(calls[0][0]).toEqual({
      where: { id: 'line-a' },
      select: {
        id: true,
        orderId: true,
        supplierId: true,
        order: { select: { id: true, displayId: true } },
      },
    });
    expect(calls[1][0]).toEqual({
      where: { id: 'line-a' },
      include: { order: true },
    });
    expect(prisma.orderItem.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.orderItem.findUnique.mock.invocationCallOrder[1],
    );
    expect(prisma.orderItem.findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.orderItem.update.mock.invocationCallOrder[0],
    );
  });

  it('returns the full order after an admin status update', async () => {
    const { service } = actionHarness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.ADMIN),
    );

    expect(result.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(result.subtotal).toBe(130);
    expect(result.total).toBe(148);
    expect(result.items.map((item: { productName: string }) => item.productName).sort()).toEqual([
      'Atlas Lamp',
      'Kijani Kettle',
    ]);
  });

  it('loads the parent order for an admin only after the item gate', async () => {
    const { service, prisma } = actionHarness();

    await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.ADMIN),
    );

    expect(prisma.orderItem.findUnique.mock.calls[0][0].select.order.select).toEqual({
      id: true,
      displayId: true,
    });
    expect(prisma.orderItem.findUnique.mock.calls[0][0].include).toBeUndefined();
    expect(prisma.orderItem.findUnique.mock.calls[1][0].include).toEqual({ order: true });
    expect(prisma.orderItem.findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.orderItem.update.mock.invocationCallOrder[0],
    );
  });

  it('rechecks supplier ownership on the full read before any write', async () => {
    const { service, prisma, calls } = actionHarness();
    prisma.orderItem.findUnique
      .mockImplementationOnce(async () => ({
        id: 'line-a',
        orderId: 'ord-mixed',
        supplierId: 'sup-a',
        order: { id: 'ord-mixed', displayId: 'WG-MIXED' },
      }))
      .mockImplementationOnce(async () => ({
        id: 'line-a',
        orderId: 'ord-mixed',
        supplierId: 'sup-b',
        status: OrderStatus.PROCESSING,
        order: { id: 'ord-mixed', displayId: 'WG-MIXED' },
      }));

    await expect(
      service.updateItemStatus(
        'ord-mixed',
        'line-a',
        { status: OrderStatus.READY_FOR_PICKUP },
        user(UserRole.SUPPLIER, 'sup-a'),
      ),
    ).rejects.toThrow(new ForbiddenException('Cannot update another supplier item'));

    expect(prisma.orderItem.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.orderItem.findUnique.mock.calls[1][0].include).toEqual({ order: true });
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(calls.refund).not.toHaveBeenCalled();
    expect(calls.clawback).not.toHaveBeenCalled();
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('reports a missing item from the ownership query without a mutation', async () => {
    const { service, prisma } = actionHarness();

    await expect(
      service.updateItemStatus(
        'ord-mixed',
        'line-missing',
        { status: OrderStatus.READY_FOR_PICKUP },
        user(UserRole.SUPPLIER, 'sup-a'),
      ),
    ).rejects.toThrow(new NotFoundException('Order item not found'));

    expect(prisma.orderItem.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.findUnique.mock.calls[0][0].include).toBeUndefined();
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
  });

  it('reports a mismatched order from the ownership query without a mutation', async () => {
    const { service, prisma } = actionHarness();

    await expect(
      service.updateItemStatus(
        'WG-OTHER',
        'line-a',
        { status: OrderStatus.READY_FOR_PICKUP },
        user(UserRole.SUPPLIER, 'sup-a'),
      ),
    ).rejects.toThrow(new NotFoundException('Order item not found'));

    expect(prisma.orderItem.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('reports an item deleted between the two reads without a mutation', async () => {
    const { service, prisma, calls } = actionHarness();
    prisma.orderItem.findUnique
      .mockImplementationOnce(async () => ({
        id: 'line-a',
        orderId: 'ord-mixed',
        supplierId: 'sup-a',
        order: { id: 'ord-mixed', displayId: 'WG-MIXED' },
      }))
      .mockImplementationOnce(async () => null);

    await expect(
      service.updateItemStatus(
        'ord-mixed',
        'line-a',
        { status: OrderStatus.CANCELLED },
        user(UserRole.SUPPLIER, 'sup-a'),
      ),
    ).rejects.toThrow(new NotFoundException('Order item not found'));

    expect(prisma.orderItem.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.orderItem.update).not.toHaveBeenCalled();
    expect(calls.refund).not.toHaveBeenCalled();
    expect(calls.clawback).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('omits the payment intent and combined totals from a supplier status update', async () => {
    const { service, prisma } = actionHarness();
    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP, pickupCode: 'PU-OWN-A' },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expectSupplierABucket(result);
    expect(result.items[0].status).toBe(OrderStatus.READY_FOR_PICKUP);
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line-a' },
        data: expect.objectContaining({
          status: OrderStatus.READY_FOR_PICKUP,
          pickupCode: 'PU-OWN-A',
        }),
      }),
    );

    const admin = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.ADMIN),
    );
    expect(admin.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(admin.subtotal).toBe(130);
    expect(admin.tax).toBe(10);
    expect(admin.deliveryFee).toBe(8);
    expect(admin.total).toBe(148);
    expect(admin.items.map((item) => item.productName).sort()).toEqual([
      'Atlas Lamp',
      'Kijani Kettle',
    ]);
  });

  it('returns a supplier-scoped response after COD collection', async () => {
    const { service, calls } = actionHarness();
    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { collectPayment: true },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(calls.collection).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'ord-mixed', supplierId: 'sup-a' }),
      }),
    );
    expectSupplierABucket(result);
  });

  it('returns a supplier-scoped response after courier details are saved', async () => {
    const { service, calls } = actionHarness(OrderStatus.SHIPPED);
    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      {
        courierDetails: {
          driverName: 'Driver A',
          driverPhone: '555-0101',
          plateNumber: 'AAA 1',
        },
      },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(calls.courierUpdate).toHaveBeenCalled();
    expectSupplierABucket(result);
  });

  it('returns a supplier-scoped response when a line cannot be fulfilled', async () => {
    const { service, calls } = actionHarness();
    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(calls.refund).not.toHaveBeenCalled();
    expect(calls.clawback).toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'line-a' }),
    );
    expect(result.items[0].status).toBe(OrderStatus.CANCELLED);
    expectSupplierABucket(result);
  });

  it('loads only the supplier line after the ownership gate', async () => {
    const { service, prisma } = openService([mixedOrder()]);
    const result = await service.findOne('WG-MIXED', user(UserRole.SUPPLIER, 'sup-a'));

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: 'WG-MIXED' }, { displayId: 'WG-MIXED' }] },
      select: {
        id: true,
        customerId: true,
        items: { select: { supplierId: true } },
      },
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ord-mixed' },
        select: expect.objectContaining({
          items: expect.objectContaining({
            where: { supplierId: 'sup-a' },
            include: expect.objectContaining({
              commission: true,
              courierBooking: true,
              product: expect.any(Object),
            }),
          }),
          shipments: expect.objectContaining({
            where: { supplierId: 'sup-a' },
          }),
          customer: { select: { phone: true } },
        }),
      }),
    );
    const detailSelect = prisma.order.findUnique.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect(detailSelect).not.toHaveProperty('stripePaymentIntentId');
    expect(detailSelect).not.toHaveProperty('stripeChargeAttemptAt');
    expect(detailSelect).not.toHaveProperty('checkoutIdempotencyKey');
    expect(detailSelect).not.toHaveProperty('paymentReconcileLeaseOwner');
    expect(detailSelect).not.toHaveProperty('subtotal');
    expect(detailSelect).not.toHaveProperty('taxAmount');
    expect(detailSelect).not.toHaveProperty('deliveryFee');
    expect(detailSelect).not.toHaveProperty('total');
    expect(detailSelect).not.toHaveProperty('paymentAmount');
    expect(detailSelect).not.toHaveProperty('displayTotal');
    expect(detailSelect.customerName).toBe(true);
    expect(detailSelect.addressLine).toBe(true);
    expect(detailSelect.paymentMode).toBe(true);
    expect(prisma.returnRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'ord-mixed', orderItem: { supplierId: 'sup-a' } },
      }),
    );
    expect(result.items.map((item) => item.productName)).toEqual(['Kijani Kettle']);
    expect(result.returnRequests).toEqual([]);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(result.total).toBe(43.5);
    expect(JSON.stringify(prisma.order.findFirst.mock.calls[0][0])).not.toContain('commission');
    expect(JSON.stringify(prisma.order.findFirst.mock.calls[0][0])).not.toContain('courierBooking');
  });

  it('keeps not-found and forbidden before the supplier line query', async () => {
    const { service, prisma } = openService([mixedOrder()]);
    await expect(
      service.findOne('WG-MIXED', user(UserRole.SUPPLIER, 'sup-c')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.findOne('WG-MISSING', user(UserRole.SUPPLIER, 'sup-a')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.returnRequest.findMany).not.toHaveBeenCalled();
  });

  it('returns only the supplier return embedded on the order detail', async () => {
    const { service } = openService([mixedOrder()], sharedDetailReturns());

    const result = await service.findOne('WG-MIXED', user(UserRole.SUPPLIER, 'sup-a'));
    const body = JSON.stringify(result);
    const [request] = result.returnRequests;

    expect(result.returnRequests).toHaveLength(1);
    expect(Object.keys(request).sort()).toEqual([
      'createdAt',
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
    ]);
    expect(request).toEqual({
      id: 'ret-a',
      orderId: 'WG-MIXED',
      paymentMode: 'test',
      orderItemId: 'line-a',
      productName: 'Kijani Kettle',
      supplierName: 'Kijani Fixture',
      reason: 'damaged',
      notes: 'kijani return note',
      quantity: 1,
      status: 'REQUESTED',
      refundStatus: 'NONE',
      refundNote: null,
      refundedAt: null,
      createdAt: '2026-01-15T00:00:00.000Z',
    });
    expect(body).toContain('kijani return note');
    expect(body).not.toContain('ret-b');
    expect(body).not.toContain('atlas return note');
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Atlas Fixture');
    expect(body).not.toContain('pi_detail_a');
    expect(body).not.toContain('pi_detail_b');
    expect(body).not.toContain('pi_mixed_secret');
    expect(request).not.toHaveProperty('stripePaymentIntentId');
    expect(request).not.toHaveProperty('paymentAmount');
    expect(request).not.toHaveProperty('subtotal');
    expect(request).not.toHaveProperty('total');
  });

  it('filters the embedded return query by order and supplier', async () => {
    const { service, prisma } = openService([mixedOrder()], sharedDetailReturns());

    await service.findOne('ord-mixed', user(UserRole.SUPPLIER, 'sup-a'));

    expect(prisma.returnRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'ord-mixed', orderItem: { supplierId: 'sup-a' } },
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { displayId: true, paymentMode: true } },
          orderItem: { select: { productName: true, supplierName: true } },
        },
      }),
    );
  });

  it('omits the payment intent on a supplier replacement and keeps it null for an admin', async () => {
    const supplierRun = replacementHarness();
    const supplier = await supplierRun.service.createReplacementOrder(
      'WG-MIXED',
      'line-a',
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    const supplierBody = JSON.stringify(supplier);
    expect(supplier.items.map((item) => item.productName)).toEqual(['Kijani Kettle']);
    expect(supplier).not.toHaveProperty('stripePaymentIntentId');
    expect(supplierBody).not.toContain('pi_parent_secret');
    expect(supplier.subtotal).toBe(40);
    expect(supplier.total).toBe(40);
    expect(supplier.paymentAmount).toBe(40);
    expect(supplier.replacesOrderId).toBe('WG-MIXED');
    expect(supplier.replacesOrderItemId).toBe('line-a');
    expect(supplierRun.tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ stripePaymentIntentId: 'pi_parent_secret' }),
      }),
    );
    expect(supplierRun.tx.product.update).toHaveBeenCalled();
    const sourceSelect = (
      supplierRun.prisma.orderItem.findUnique.mock.calls[0][0] as {
        include: { order: { select: Record<string, unknown> } };
      }
    ).include.order.select;
    expect(sourceSelect.displayId).toBe(true);
    expect(sourceSelect.customerId).toBe(true);
    expect(sourceSelect.customerName).toBe(true);
    expect(sourceSelect.customerEmail).toBe(true);
    expect(sourceSelect.customerPhone).toBe(true);
    expect(sourceSelect.currency).toBe(true);
    expect(sourceSelect.settlementCurrency).toBe(true);
    expect(sourceSelect.addressLine).toBe(true);
    expect(sourceSelect.city).toBe(true);
    expect(sourceSelect.stripePaymentIntentId).toBeUndefined();
    expect(sourceSelect.stripeChargeAttemptAt).toBeUndefined();
    expect(sourceSelect.checkoutIdempotencyKey).toBeUndefined();
    expect(sourceSelect.subtotal).toBeUndefined();
    expect(sourceSelect.taxAmount).toBeUndefined();
    expect(sourceSelect.deliveryFee).toBeUndefined();
    expect(sourceSelect.total).toBeUndefined();
    expect(sourceSelect.paymentAmount).toBeUndefined();
    expect(sourceSelect.displayTotal).toBeUndefined();

    const adminRun = replacementHarness();
    const admin = await adminRun.service.createReplacementOrder(
      'ord-mixed',
      'line-a',
      user(UserRole.ADMIN),
    );
    expect(admin).toHaveProperty('stripePaymentIntentId', null);
    expect(JSON.stringify(admin)).not.toContain('pi_parent_secret');
    expect(admin.items).toHaveLength(1);
    expect(admin.total).toBe(40);
    expect(adminRun.prisma.orderItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({ order: true }),
      }),
    );

    const customerRun = replacementHarness();
    await expect(
      customerRun.service.createReplacementOrder(
        'ord-mixed',
        'line-a',
        user(UserRole.CUSTOMER),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(customerRun.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a replacement of another supplier item before creating an order', async () => {
    const { service, prisma, tx } = replacementHarness();

    await expect(
      service.createReplacementOrder(
        'WG-MIXED',
        'line-a',
        user(UserRole.SUPPLIER, 'sup-b'),
      ),
    ).rejects.toThrow(
      new ForbiddenException('Cannot replace another supplier item'),
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
    expect(tx.inventoryLedger.create).not.toHaveBeenCalled();
    expect(tx.returnRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line-a' },
        include: expect.objectContaining({
          order: {
            select: {
              displayId: true,
              customerId: true,
              customerName: true,
              customerEmail: true,
              customerPhone: true,
              currency: true,
              settlementCurrency: true,
              addressLine: true,
              city: true,
            },
          },
          product: true,
        }),
      }),
    );
    const sourceQuery = prisma.orderItem.findUnique.mock.calls[0][0] as {
      include: { order: { select: Record<string, unknown> } };
    };
    expect(sourceQuery.include.order.select).not.toHaveProperty(
      'stripePaymentIntentId',
    );
    expect(sourceQuery.include.order.select).not.toHaveProperty('subtotal');
    expect(sourceQuery.include.order.select).not.toHaveProperty('total');
    expect(sourceQuery.include.order.select).not.toHaveProperty('paymentAmount');
  });

  it('keeps parent money on a single-supplier detail query and omits the payment intent', async () => {
    const { service, prisma } = openService([singleOrder()]);
    const result = await service.findOne('WG-SINGLE', user(UserRole.SUPPLIER, 'sup-a'));
    const select = prisma.order.findUnique.mock.calls[0][0].select as Record<
      string,
      unknown
    >;

    expect(select.stripePaymentIntentId).toBeUndefined();
    expect(select.stripeChargeAttemptAt).toBeUndefined();
    expect(select.checkoutIdempotencyKey).toBeUndefined();
    expect(select.paymentReconcileLeaseOwner).toBeUndefined();
    expect(select.subtotal).toBe(true);
    expect(select.taxAmount).toBe(true);
    expect(select.deliveryFee).toBe(true);
    expect(select.total).toBe(true);
    expect(select.paymentAmount).toBe(true);
    expect(select.displayTotal).toBe(true);
    expect(result.subtotal).toBe(40);
    expect(result.tax).toBe(1.5);
    expect(result.deliveryFee).toBe(2);
    expect(result.total).toBe(43.5);
    expect(result.paymentAmount).toBe(107);
    expect(result.displayTotal).toBe(107);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
  });

  it('keeps customer and admin detail on the full order query', async () => {
    const { service, prisma } = openService([mixedOrder()]);
    const customer = await service.findOne('WG-MIXED', user(UserRole.CUSTOMER));
    const admin = await service.findOne('WG-MIXED', user(UserRole.ADMIN));

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.any(Object) }),
    );
    expect(customer.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(customer.total).toBe(148);
    expect(admin.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(admin.total).toBe(148);
  });

  it('keeps parent money on the supplier list and loads only that supplier’s shipments', async () => {
    const { service, prisma } = openService([mixedOrder()]);
    const [result] = await service.list(user(UserRole.SUPPLIER, 'sup-a'));
    const select = (prisma.order.findMany.mock.calls[0][0] as {
      select: Record<string, any>;
    }).select;

    expect(select.stripePaymentIntentId).toBeUndefined();
    expect(select.stripeChargeAttemptAt).toBeUndefined();
    expect(select.checkoutIdempotencyKey).toBeUndefined();
    expect(select.subtotal).toBe(true);
    expect(select.taxAmount).toBe(true);
    expect(select.deliveryFee).toBe(true);
    expect(select.total).toBe(true);
    expect(select.paymentAmount).toBe(true);
    expect(select.displayTotal).toBe(true);
    expect(select.items.where).toEqual({ supplierId: 'sup-a' });
    expect(select.shipments.where).toEqual({ supplierId: 'sup-a' });
    expect(result.total).toBe(43.5);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
  });

  it('reloads a supplier action without the payment intent and with that supplier’s shipments', async () => {
    const shared = actionHarness();
    const sharedResult = await shared.service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    const sharedSelect = shared.prisma.order.findUniqueOrThrow.mock.calls.at(-1)[0].select;
    expect(sharedSelect.stripePaymentIntentId).toBeUndefined();
    expect(sharedSelect.stripeChargeAttemptAt).toBeUndefined();
    expect(sharedSelect.checkoutIdempotencyKey).toBeUndefined();
    expect(sharedSelect.paymentReconcileNextAt).toBeUndefined();
    expect(sharedSelect.subtotal).toBe(true);
    expect(sharedSelect.displayTotal).toBe(true);
    expect(sharedSelect.shipments.where).toEqual({ supplierId: 'sup-a' });
    expect(sharedSelect.items.where).toEqual({ supplierId: 'sup-a' });
    expectSupplierABucket(sharedResult);

    const single = actionHarness(OrderStatus.PROCESSING, { singleSupplier: true });
    const singleResult = await single.service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    expect(singleResult.subtotal).toBe(40);
    expect(singleResult.tax).toBe(1.5);
    expect(singleResult.deliveryFee).toBe(2);
    expect(singleResult.total).toBe(43.5);
    expect(singleResult.paymentAmount).toBe(107);
    expect(singleResult.displayTotal).toBe(107);
    expect(singleResult).not.toHaveProperty('stripePaymentIntentId');

    const admin = actionHarness();
    const adminResult = await admin.service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.ADMIN),
    );
    const adminQuery = admin.prisma.order.findUniqueOrThrow.mock.calls.at(-1)[0];
    expect(adminQuery.select).toBeUndefined();
    expect(adminQuery.include.items.where).toBeUndefined();
    expect(adminResult.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(adminResult.total).toBe(148);
    expect(adminResult.items).toHaveLength(2);
  });
});
