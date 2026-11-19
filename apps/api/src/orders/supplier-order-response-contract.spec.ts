import {
  OrderStatus,
  PaymentStatus,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { OrdersService } from './orders.service';
import { cardRefundAmount } from './stripe.service';
import {
  refundPaymentForSupplierAction,
  remainingCodPayment,
} from './settlement-allocation';

/**
 * Prisma mocks return the whole fixture. They do not apply `select` or
 * `include`, so a response assertion proves the serializer and a
 * `mock.calls` assertion proves the query. Neither proves the other.
 */

const SECRETS = [
  'pi_mixed_secret',
  'pi_card_secret',
  'pi_cod_secret',
  'attempt-secret',
  'idem-mixed',
  'worker-secret',
];

type Booking = {
  reference: string;
  status: string;
  courierName: string;
  driverName: string;
  driverPhone: string;
  plateNumber: string;
  fee: number | null;
  trackingUrl: string | null;
};

type Line = {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  status: OrderStatus;
  trackingCode: string;
  pickupCode: string;
  carrier: string;
  courierName: string;
  courierBooking: Booking;
};

type Shipment = {
  id: string;
  orderId: string;
  supplierId: string;
  supplierName: string;
  merchandise: number;
  deliveryFee: number;
  merchandiseTax: number;
  deliveryTax: number;
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
  refundedAmount: number;
};

function user(role: UserRole, supplierId?: string) {
  return {
    sub: role === UserRole.CUSTOMER ? 'cust-1' : `user-${supplierId ?? role}`,
    email: 'person@example.com',
    name: 'Test User',
    role,
    supplierId,
  };
}

function booking(input: {
  reference: string;
  driverName: string;
  driverPhone: string;
  plateNumber: string;
}): Booking {
  return {
    reference: input.reference,
    status: 'booked',
    courierName: 'Courier',
    driverName: input.driverName,
    driverPhone: input.driverPhone,
    plateNumber: input.plateNumber,
    fee: null,
    trackingUrl: null,
  };
}

function line(input: {
  id: string;
  supplierId: string;
  supplierName: string;
  productName: string;
  productId: string;
  lineTotal: number;
  pickupCode: string;
  trackingCode: string;
  driverName: string;
  driverPhone: string;
  plateNumber: string;
  status?: OrderStatus;
  carrier?: string;
}): Line {
  return {
    id: input.id,
    orderId: 'ord-mixed',
    productId: input.productId,
    productName: input.productName,
    supplierId: input.supplierId,
    supplierName: input.supplierName,
    unitPrice: input.lineTotal,
    quantity: 1,
    lineTotal: input.lineTotal,
    status: input.status ?? OrderStatus.PROCESSING,
    trackingCode: input.trackingCode,
    pickupCode: input.pickupCode,
    carrier: input.carrier ?? 'pickup',
    courierName: 'Courier',
    courierBooking: booking({
      reference: input.trackingCode,
      driverName: input.driverName,
      driverPhone: input.driverPhone,
      plateNumber: input.plateNumber,
    }),
  };
}

function kijaniLine(status?: OrderStatus): Line {
  return line({
    id: 'line-a',
    supplierId: 'sup-a',
    supplierName: 'Kijani Fixture',
    productName: 'Kijani Kettle',
    productId: 'p-a',
    lineTotal: 40,
    pickupCode: 'PU-OWN-A',
    trackingCode: 'CR-OWN-A',
    driverName: 'Driver A',
    driverPhone: '555-0101',
    plateNumber: 'AAA 1',
    status,
  });
}

function atlasLine(status?: OrderStatus, carrier?: string): Line {
  return line({
    id: 'line-b',
    supplierId: 'sup-b',
    supplierName: 'Atlas Fixture',
    productName: 'Atlas Lamp',
    productId: 'p-b',
    lineTotal: 90,
    pickupCode: 'PU-OTHER-B',
    trackingCode: 'CR-OTHER-B',
    driverName: 'Driver B',
    driverPhone: '555-0199',
    plateNumber: 'ZZZ 9',
    status,
    carrier,
  });
}

function shipment(input: {
  id: string;
  supplierId: string;
  supplierName: string;
  merchandise: number;
  deliveryFee: number;
  merchandiseTax: number;
  deliveryTax: number;
  paymentMerchandise: number;
  paymentDelivery: number;
  paymentTax: number;
}): Shipment {
  return {
    ...input,
    orderId: 'ord-mixed',
    refundedAmount: 0,
  };
}

const kijaniShipment = () =>
  shipment({
    id: 'ship-a',
    supplierId: 'sup-a',
    supplierName: 'Kijani Fixture',
    merchandise: 40,
    deliveryFee: 2,
    merchandiseTax: 1,
    deliveryTax: 0.5,
    paymentMerchandise: 100,
    paymentDelivery: 5,
    paymentTax: 2,
  });

const atlasShipment = () =>
  shipment({
    id: 'ship-b',
    supplierId: 'sup-b',
    supplierName: 'Atlas Fixture',
    merchandise: 90,
    deliveryFee: 6,
    merchandiseTax: 8,
    deliveryTax: 0.5,
    paymentMerchandise: 200,
    paymentDelivery: 10,
    paymentTax: 4,
  });

function harness(options?: {
  lines?: Line[];
  shipments?: Shipment[];
  paymentMode?: string;
  paymentStatus?: PaymentStatus;
  paymentIntent?: string;
  subtotal?: number;
  taxAmount?: number;
  deliveryFee?: number;
  total?: number;
  paymentAmount?: number;
  orderId?: string;
}) {
  const orderId = options?.orderId ?? 'ord-mixed';
  const lines = (options?.lines ?? [kijaniLine(), atlasLine()]).map((row) => ({
    ...row,
    orderId,
    courierBooking: { ...row.courierBooking },
  }));
  const shipments = (options?.shipments ?? [kijaniShipment(), atlasShipment()]).map(
    (row) => ({ ...row, orderId }),
  );
  const products = new Map<string, { id: string; stock: number; supplierId: string }>([
    ['p-a', { id: 'p-a', stock: 4, supplierId: 'sup-a' }],
    ['p-b', { id: 'p-b', stock: 9, supplierId: 'sup-b' }],
  ]);
  const header = () => ({
    id: orderId,
    displayId: orderId === 'ord-mixed' ? 'WG-MIXED' : 'WG-SINGLE',
    customerId: 'cust-1',
    customerName: 'Amina Example',
    customerEmail: 'amina@example.com',
    customerPhone: '555-0100',
    customer: { phone: '555-0100' },
    status: OrderStatus.PROCESSING,
    paymentStatus: options?.paymentStatus ?? PaymentStatus.PAID,
    paymentMethod: options?.paymentMode === 'cod' ? 'pay_on_delivery' : 'card',
    paymentMode: options?.paymentMode ?? 'test',
    stripePaymentIntentId: options?.paymentIntent ?? 'pi_mixed_secret',
    stripeChargeAttemptAt: 'attempt-secret',
    checkoutIdempotencyKey: 'idem-mixed',
    paymentReconcileLeaseOwner: 'worker-secret',
    currency: 'USD',
    settlementCurrency: 'USD',
    displayCurrency: 'TZS',
    paymentCurrency: 'USD',
    fxRate: 2500,
    subtotal: options?.subtotal ?? 130,
    taxAmount: options?.taxAmount ?? 10,
    deliveryFee: options?.deliveryFee ?? 8,
    total: options?.total ?? 148,
    paymentAmount: options?.paymentAmount ?? 400000,
    displaySubtotal: 900001,
    displayTaxAmount: 900002,
    displayDeliveryFee: 900003,
    displayTotal: 400000,
    addressLine: '1 Market Street',
    city: 'Dar es Salaam',
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
  });
  const snapshot = () => ({
    ...header(),
    items: lines.map((row) => ({
      ...row,
      courierBooking: { ...row.courierBooking },
    })),
    shipments: shipments.map((row) => ({ ...row })),
  });
  const refund = jest.fn(async () => ({ ok: true, status: 'succeeded' }));
  const clawback = jest.fn(async () => ({}));
  const reverse = jest.fn(async () => undefined);
  const prisma: any = {
    order: {
      findMany: jest.fn(async () => [snapshot()]),
      findUnique: jest.fn(async () => snapshot()),
      findUniqueOrThrow: jest.fn(async () => snapshot()),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    orderItem: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = lines.find((item) => item.id === where.id);
        return row ? { ...row, order: header() } : null;
      }),
      findMany: jest.fn(async (args?: { where?: Record<string, any> }) => {
        const where = args?.where ?? {};
        if (where.supplierId?.not) {
          return lines
            .filter(
              (item) =>
                item.supplierId !== where.supplierId.not &&
                (!where.orderId?.in || where.orderId.in.includes(item.orderId)),
            )
            .map((item) => ({ orderId: item.orderId }));
        }
        const orderFilter =
          typeof where.orderId === 'string' ? where.orderId : undefined;
        return lines
          .filter((item) => !orderFilter || item.orderId === orderFilter)
          .map((item) => ({ ...item }));
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = lines.find((item) => item.id === where.id);
          if (!row) return null;
          for (const [key, value] of Object.entries(data)) {
            if (value !== undefined) (row as Record<string, unknown>)[key] = value;
          }
          return { ...row };
        },
      ),
    },
    orderShipment: {
      findMany: jest.fn(async () => shipments.map((row) => ({ ...row }))),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { refundedAmount: { toString(): string } };
        }) => {
          const row = shipments.find((item) => item.id === where.id);
          if (row) row.refundedAmount = Number(data.refundedAmount);
          return row;
        },
      ),
    },
    cashCollection: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async () => ({ id: 'col-1' })),
    },
    courierBooking: {
      findUnique: jest.fn(async ({ where }: { where: { orderItemId: string } }) => {
        const row = lines.find((item) => item.id === where.orderItemId);
        return row ? { ...row.courierBooking } : null;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { orderItemId: string };
          data: Partial<Booking>;
        }) => {
          const row = lines.find((item) => item.id === where.orderItemId);
          if (row) Object.assign(row.courierBooking, data);
          return row?.courierBooking ?? null;
        },
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
    product: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = products.get(where.id);
        return row ? { ...row } : null;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { stock: number };
        }) => {
          const row = products.get(where.id);
          if (row) row.stock = data.stock;
          return row;
        },
      ),
    },
    inventoryLedger: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const service = new OrdersService(
    prisma as never,
    {
      advanceRecognitionForItem: jest.fn(async () => null),
      clawbackForOrderItem: clawback,
    } as never,
    { refundCardCharge: refund } as never,
    { onSupplierShipped: jest.fn() } as never,
    {} as never,
    {} as never,
    { record: jest.fn(async () => undefined) } as never,
    { reverseIfTransferred: reverse, transferIfSettleable: jest.fn() } as never,
    {} as never,
    { reserveReturnClawback: jest.fn(), applyReturnClawback: jest.fn() } as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, lines, shipments, products, refund, clawback, reverse };
}

function expectSecretsAbsent(body: string) {
  for (const secret of SECRETS) expect(body).not.toContain(secret);
}

function expectSupplierBucket(
  result: {
    items: Array<{ id: string; productName: string }>;
    subtotal: number;
    tax: number;
    deliveryFee: number;
    total: number;
    paymentAmount: number;
    displayTotal: number | null;
  },
  expected: {
    id: string;
    productName: string;
    subtotal: number;
    tax: number;
    deliveryFee: number;
    total: number;
    paymentAmount: number;
  },
) {
  expect(result.items.map((item) => item.id)).toEqual([expected.id]);
  expect(result.items[0].productName).toBe(expected.productName);
  expect(result.subtotal).toBe(expected.subtotal);
  expect(result.tax).toBe(expected.tax);
  expect(result.deliveryFee).toBe(expected.deliveryFee);
  expect(result.total).toBe(expected.total);
  expect(result.paymentAmount).toBe(expected.paymentAmount);
  expect(result.displayTotal).toBeNull();
  expect(result).not.toHaveProperty('stripePaymentIntentId');
}

describe('customer and admin order list contract', () => {
  it('loads the customer list with the full order include', async () => {
    const { service, prisma } = harness();

    await service.list(user(UserRole.CUSTOMER));

    const query = prisma.order.findMany.mock.calls[0][0];
    expect(query.where).toEqual({ customerId: 'cust-1' });
    expect(query.orderBy).toEqual({ createdAt: 'desc' });
    expect(query.select).toBeUndefined();
    expect(query.include.items.include.commission).toBe(true);
    expect(query.include.items.include.courierBooking).toBe(true);
    expect(query.include.shipments).toBe(true);
    expect(query.include.customer).toEqual({ select: { phone: true } });
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('returns both suppliers, the payment intent, and combined totals to the customer', async () => {
    const { service } = harness();

    const [result] = await service.list(user(UserRole.CUSTOMER));
    const body = JSON.stringify(result);

    expect(result.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(result.subtotal).toBe(130);
    expect(result.tax).toBe(10);
    expect(result.deliveryFee).toBe(8);
    expect(result.total).toBe(148);
    expect(result.paymentAmount).toBe(400000);
    expect(result.displayTotal).toBe(400000);
    expect(result.items.map((item) => item.productName).sort()).toEqual([
      'Atlas Lamp',
      'Kijani Kettle',
    ]);
    expect(body).toContain('PU-OWN-A');
    expect(body).toContain('PU-OTHER-B');
    expect(body).toContain('Driver A');
    expect(body).toContain('Driver B');
    expect(body).toContain('AAA 1');
    expect(body).toContain('ZZZ 9');
    expect(result).not.toHaveProperty('stripeChargeAttemptAt');
    expect(result).not.toHaveProperty('checkoutIdempotencyKey');
    expect(result).not.toHaveProperty('paymentReconcileLeaseOwner');
    expect(body).not.toContain('attempt-secret');
    expect(body).not.toContain('idem-mixed');
    expect(body).not.toContain('worker-secret');
  });

  it('loads the admin list with the full order include and no customer filter', async () => {
    const { service, prisma } = harness();

    await service.list(user(UserRole.ADMIN));

    const query = prisma.order.findMany.mock.calls[0][0];
    expect(query.where).toBeUndefined();
    expect(query.take).toBe(100);
    expect(query.select).toBeUndefined();
    expect(query.include.shipments).toBe(true);
    expect(query.include.items.include.courierBooking).toBe(true);
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('returns the full order to an admin', async () => {
    const { service } = harness();

    const [result] = await service.list(user(UserRole.ADMIN));

    expect(result.stripePaymentIntentId).toBe('pi_mixed_secret');
    expect(result.total).toBe(148);
    expect(result.subtotal).toBe(130);
    expect(result.items).toHaveLength(2);
    expect(JSON.stringify(result)).toContain('Driver A');
    expect(JSON.stringify(result)).toContain('Driver B');
    expect(result).not.toHaveProperty('paymentReconcileLeaseOwner');
  });
});

describe('supplier action reload without shipment buckets', () => {
  function noBucketHarness() {
    return harness({ shipments: [] });
  }

  it('scopes supplier A reload and the other-supplier probe', async () => {
    const { service, prisma } = noBucketHarness();

    await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    const reload = prisma.order.findUniqueOrThrow.mock.calls.at(-1)[0];
    expect(reload.select.stripePaymentIntentId).toBeUndefined();
    expect(reload.select.stripeChargeAttemptAt).toBeUndefined();
    expect(reload.select.checkoutIdempotencyKey).toBeUndefined();
    expect(reload.select.paymentReconcileLeaseOwner).toBeUndefined();
    expect(reload.select.items.where).toEqual({ supplierId: 'sup-a' });
    expect(reload.select.shipments.where).toEqual({ supplierId: 'sup-a' });
    const probe = prisma.orderItem.findMany.mock.calls.find(
      (call: { 0?: { where?: { supplierId?: { not?: string } } } }) =>
        call[0]?.where?.supplierId?.not === 'sup-a',
    );
    expect(probe?.[0]).toEqual({
      where: {
        orderId: { in: ['ord-mixed'] },
        supplierId: { not: 'sup-a' },
      },
      select: { orderId: true },
      distinct: ['orderId'],
    });
    const probeIndex = prisma.orderItem.findMany.mock.calls.findIndex(
      (call: { 0?: { where?: { supplierId?: { not?: string } } } }) =>
        call[0]?.where?.supplierId?.not === 'sup-a',
    );
    expect(prisma.order.findUniqueOrThrow.mock.invocationCallOrder.at(-1)).toBeLessThan(
      prisma.orderItem.findMany.mock.invocationCallOrder[probeIndex],
    );
  });

  it('gives supplier A merchandise fallback totals and only Kijani lines', async () => {
    const { service } = noBucketHarness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    const body = JSON.stringify(result);

    expectSupplierBucket(result, {
      id: 'line-a',
      productName: 'Kijani Kettle',
      subtotal: 40,
      tax: 0,
      deliveryFee: 0,
      total: 40,
      paymentAmount: 40,
    });
    expect(result.total).not.toBe(148);
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Driver B');
    expect(body).not.toContain('ZZZ 9');
    expectSecretsAbsent(body);
  });

  it('scopes supplier B reload to supplier B', async () => {
    const { service, prisma } = noBucketHarness();

    await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-b'),
    );

    const reload = prisma.order.findUniqueOrThrow.mock.calls.at(-1)[0];
    expect(reload.select.items.where).toEqual({ supplierId: 'sup-b' });
    expect(reload.select.shipments.where).toEqual({ supplierId: 'sup-b' });
    expect(reload.select.stripePaymentIntentId).toBeUndefined();
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith({
      where: {
        orderId: { in: ['ord-mixed'] },
        supplierId: { not: 'sup-b' },
      },
      select: { orderId: true },
      distinct: ['orderId'],
    });
  });

  it('gives supplier B merchandise fallback totals and only Atlas lines', async () => {
    const { service } = noBucketHarness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-b'),
    );
    const body = JSON.stringify(result);

    expectSupplierBucket(result, {
      id: 'line-b',
      productName: 'Atlas Lamp',
      subtotal: 90,
      tax: 0,
      deliveryFee: 0,
      total: 90,
      paymentAmount: 90,
    });
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('Driver A');
    expect(body).not.toContain('AAA 1');
    expectSecretsAbsent(body);
  });
});

describe('supplier B action responses', () => {
  function sharedCod() {
    return harness({
      paymentMode: 'cod',
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: 'pi_cod_secret',
    });
  }

  it('returns only supplier B lines after a status update', async () => {
    const { service } = harness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { status: OrderStatus.READY_FOR_PICKUP, pickupCode: 'PU-OTHER-B' },
      user(UserRole.SUPPLIER, 'sup-b'),
    );
    const body = JSON.stringify(result);

    expectSupplierBucket(result, {
      id: 'line-b',
      productName: 'Atlas Lamp',
      subtotal: 90,
      tax: 8.5,
      deliveryFee: 6,
      total: 104.5,
      paymentAmount: 214,
    });
    expect(result.items[0].pickupCode).toBe('PU-OTHER-B');
    expect(result.items[0].courierBooking?.driverName).toBe('Driver B');
    expect(result.items[0].courierBooking?.plateNumber).toBe('ZZZ 9');
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('PU-OWN-A');
    expect(body).not.toContain('Driver A');
    expect(body).not.toContain('AAA 1');
    expect(body).not.toContain('400000');
    expectSecretsAbsent(body);
  });

  it('records a COD collection for supplier B only', async () => {
    const { service, prisma, refund } = sharedCod();
    const expected = remainingCodPayment({
      shipment: {
        supplierId: 'sup-b',
        supplierName: 'Atlas Fixture',
        merchandise: 90,
        deliveryFee: 6,
        merchandiseTax: 8,
        deliveryTax: 0.5,
        paymentMerchandise: 200,
        paymentDelivery: 10,
        paymentTax: 4,
      },
      liveMerchandise: 90,
    });

    await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { collectPayment: true },
      user(UserRole.SUPPLIER, 'sup-b'),
    );

    expect(prisma.cashCollection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'ord-mixed',
          supplierId: 'sup-b',
          amount: expect.anything(),
        }),
      }),
    );
    const amount = Number(
      prisma.cashCollection.create.mock.calls[0][0].data.amount,
    );
    expect(amount).toBe(expected);
    expect(JSON.stringify(prisma.cashCollection.create.mock.calls)).not.toContain(
      'sup-a',
    );
    expect(refund).not.toHaveBeenCalled();
  });

  it('returns only supplier B lines after COD collection', async () => {
    const { service } = sharedCod();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { collectPayment: true },
      user(UserRole.SUPPLIER, 'sup-b'),
    );
    const body = JSON.stringify(result);

    expect(result.items.map((item) => item.productName)).toEqual(['Atlas Lamp']);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('Driver A');
    expectSecretsAbsent(body);
  });

  it('saves courier details on supplier B booking', async () => {
    const { service, prisma } = harness({
      lines: [kijaniLine(), atlasLine(OrderStatus.SHIPPED, 'courier')],
    });

    await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      {
        courierDetails: {
          driverName: 'Baba Driver',
          driverPhone: '0712345678',
          plateNumber: 'T 123 ABC',
        },
      },
      user(UserRole.SUPPLIER, 'sup-b'),
    );

    expect(prisma.courierBooking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderItemId: 'line-b' },
        data: expect.objectContaining({
          driverName: 'Baba Driver',
          driverPhone: '0712345678',
          plateNumber: 'T 123 ABC',
        }),
      }),
    );
    expect(JSON.stringify(prisma.courierBooking.update.mock.calls)).not.toContain(
      'line-a',
    );
  });

  it('returns only supplier B courier fields after the save', async () => {
    const { service } = harness({
      lines: [kijaniLine(), atlasLine(OrderStatus.SHIPPED, 'courier')],
    });

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      {
        courierDetails: {
          driverName: 'Baba Driver',
          driverPhone: '0712345678',
          plateNumber: 'T 123 ABC',
        },
      },
      user(UserRole.SUPPLIER, 'sup-b'),
    );
    const body = JSON.stringify(result);

    expect(result.items.map((item) => item.id)).toEqual(['line-b']);
    expect(result.items[0].courierBooking?.driverName).toBe('Baba Driver');
    expect(result.items[0].courierBooking?.plateNumber).toBe('T 123 ABC');
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('Driver A');
    expect(body).not.toContain('AAA 1');
    expect(body).not.toContain('Driver B');
    expectSecretsAbsent(body);
  });

  it('returns only supplier B lines when that line cannot be fulfilled', async () => {
    const { service, refund } = sharedCod();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-b',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-b'),
    );
    const body = JSON.stringify(result);

    expect(result.items.map((item) => item.id)).toEqual(['line-b']);
    expect(result.items[0].status).toBe(OrderStatus.CANCELLED);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(body).not.toContain('Kijani Kettle');
    expect(body).not.toContain('Driver A');
    expect(refund).not.toHaveBeenCalled();
    expectSecretsAbsent(body);
  });
});

describe('shared display amounts', () => {
  it('keeps supplier merchandise totals and does not emit parent display components', async () => {
    const { service } = harness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    const body = JSON.stringify(result);

    expect(result.subtotal).toBe(40);
    expect(result.tax).toBe(1.5);
    expect(result.deliveryFee).toBe(2);
    expect(result.total).toBe(43.5);
    expect(result.displayTotal).toBeNull();
    // toResponse never copies these three keys. The shared object sets them
    // null, so the JSON contract is absence rather than a null property.
    expect(result).not.toHaveProperty('displaySubtotal');
    expect(result).not.toHaveProperty('displayTaxAmount');
    expect(result).not.toHaveProperty('displayDeliveryFee');
    expect(body).not.toContain('900001');
    expect(body).not.toContain('900002');
    expect(body).not.toContain('900003');
    expect(body).not.toContain('400000');
  });

  it('still selects parent display columns on the shared reload', async () => {
    const { service, prisma } = harness();

    await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.READY_FOR_PICKUP },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    const select = prisma.order.findUniqueOrThrow.mock.calls.at(-1)[0].select;
    expect(select.displaySubtotal).toBe(true);
    expect(select.displayTaxAmount).toBe(true);
    expect(select.displayDeliveryFee).toBe(true);
    expect(select.displayTotal).toBe(true);
    expect(select.stripePaymentIntentId).toBeUndefined();
  });
});

describe('cannot-fulfil stock and payment intent', () => {
  it('restores only the COD line and does not refund a payment intent', async () => {
    const { service, prisma, products, refund, clawback, reverse } = harness({
      lines: [kijaniLine()],
      shipments: [],
      paymentMode: 'cod',
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: 'pi_cod_secret',
      subtotal: 40,
      taxAmount: 1.5,
      deliveryFee: 2,
      total: 43.5,
      paymentAmount: 43.5,
      orderId: 'ord-single',
    });

    await service.updateItemStatus(
      'ord-single',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'line-a' },
        data: { status: OrderStatus.CANCELLED },
      }),
    );
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p-a' },
        data: expect.objectContaining({ stock: 5, stockStatus: StockStatus.LOW_STOCK }),
      }),
    );
    expect(products.get('p-b')?.stock).toBe(9);
    expect(prisma.inventoryLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'p-a',
          supplierId: 'sup-a',
          delta: 1,
          reason: 'LINE_CANCELLED',
          eventId: 'order-restore-LINE_CANCELLED-ord-single-p-a-base',
          userId: 'cust-1',
          quantityAfter: 5,
        }),
      }),
    );
    expect(refund).not.toHaveBeenCalled();
    expect(clawback).toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'line-a' }),
    );
    expect(reverse).toHaveBeenCalledWith('line-a');
  });

  it('omits the COD payment intent from the supplier response', async () => {
    const { service } = harness({
      lines: [kijaniLine()],
      shipments: [],
      paymentMode: 'cod',
      paymentStatus: PaymentStatus.PENDING,
      paymentIntent: 'pi_cod_secret',
      subtotal: 40,
      taxAmount: 1.5,
      deliveryFee: 2,
      total: 43.5,
      paymentAmount: 43.5,
      orderId: 'ord-single',
    });

    const result = await service.updateItemStatus(
      'ord-single',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(result.items[0].status).toBe(OrderStatus.CANCELLED);
    expect(result.total).toBe(43.5);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(JSON.stringify(result)).not.toContain('pi_cod_secret');
  });

  it('refunds the card payment intent for that supplier line', async () => {
    const { service, prisma, refund } = harness({
      lines: [kijaniLine()],
      shipments: [],
      paymentMode: 'test',
      paymentStatus: PaymentStatus.PAID,
      paymentIntent: 'pi_card_secret',
      subtotal: 40,
      taxAmount: 0,
      deliveryFee: 10,
      total: 50,
      paymentAmount: 50,
      orderId: 'ord-single',
    });
    const expected = cardRefundAmount({
      paymentAmount: 50,
      subtotal: 40,
      unitPrice: 40,
      quantity: 1,
    });
    // The harness ignores select, so the gate row carries a different payment
    // intent. A refund of that value would mean the full read was not used.
    prisma.orderItem.findUnique.mockImplementationOnce(async () => ({
      id: 'line-a',
      orderId: 'ord-single',
      supplierId: 'sup-a',
      order: {
        id: 'ord-single',
        displayId: 'WG-SINGLE',
        stripePaymentIntentId: 'pi_gate_must_not_refund',
        paymentAmount: 999999,
        subtotal: 999999,
        total: 999999,
      },
    }));

    await service.updateItemStatus(
      'ord-single',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(prisma.orderItem.findUnique.mock.calls[0][0]).toEqual({
      where: { id: 'line-a' },
      select: {
        id: true,
        orderId: true,
        supplierId: true,
        order: { select: { id: true, displayId: true } },
      },
    });
    const gateQuery = JSON.stringify(prisma.orderItem.findUnique.mock.calls[0][0]);
    expect(gateQuery).not.toContain('stripePaymentIntentId');
    expect(gateQuery).not.toContain('paymentAmount');
    expect(gateQuery).not.toContain('subtotal');
    expect(gateQuery).not.toContain('taxAmount');
    expect(gateQuery).not.toContain('deliveryFee');
    expect(gateQuery).not.toContain('"total"');
    expect(prisma.orderItem.findUnique.mock.calls[1][0]).toEqual({
      where: { id: 'line-a' },
      include: { order: true },
    });
    expect(prisma.orderItem.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.orderItem.findUnique.mock.invocationCallOrder[1],
    );
    expect(prisma.orderItem.findUnique.mock.invocationCallOrder[1]).toBeLessThan(
      refund.mock.invocationCallOrder[0],
    );
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_card_secret',
        amount: expected,
        currency: 'USD',
        orderId: 'ord-single',
        idempotencyKey: 'winger-line-cancel-line-a',
        reason: 'line_cancel',
      }),
    );
    const refundCalls = JSON.stringify(refund.mock.calls);
    expect(refundCalls).not.toContain('pi_gate_must_not_refund');
    expect(refundCalls).not.toContain('999999');
    expect(prisma.product.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p-a' } }),
    );
  });

  it('keeps the card payment intent out of the supplier response', async () => {
    const { service } = harness({
      lines: [kijaniLine()],
      shipments: [],
      paymentMode: 'test',
      paymentStatus: PaymentStatus.PAID,
      paymentIntent: 'pi_card_secret',
      subtotal: 40,
      taxAmount: 0,
      deliveryFee: 10,
      total: 50,
      paymentAmount: 50,
      orderId: 'ord-single',
    });

    const result = await service.updateItemStatus(
      'ord-single',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(result.total).toBe(50);
    expect(result.paymentAmount).toBe(50);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(JSON.stringify(result)).not.toContain('pi_card_secret');
  });

  it('cancels only the acting supplier line and refunds only that bucket', async () => {
    const { service, prisma, lines, products, refund, reverse } = harness();
    const expected = refundPaymentForSupplierAction({
      shipment: {
        supplierId: 'sup-a',
        supplierName: 'Kijani Fixture',
        merchandise: 40,
        deliveryFee: 2,
        merchandiseTax: 1,
        deliveryTax: 0.5,
        paymentMerchandise: 100,
        paymentDelivery: 5,
        paymentTax: 2,
        refundedAmount: 0,
      },
      returnedMerchandise: 40,
      includeDelivery: true,
    });

    await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );

    expect(lines.find((item) => item.id === 'line-a')?.status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(lines.find((item) => item.id === 'line-b')?.status).toBe(
      OrderStatus.PROCESSING,
    );
    expect(prisma.orderItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'line-b' } }),
    );
    expect(products.get('p-a')?.stock).toBe(5);
    expect(products.get('p-b')?.stock).toBe(9);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_mixed_secret',
        amount: expected,
        idempotencyKey: 'winger-line-cancel-line-a',
        reason: 'line_cancel',
      }),
    );
    expect(prisma.orderShipment.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ship-a' } }),
    );
    expect(prisma.orderShipment.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'ship-b' } }),
    );
    expect(reverse).toHaveBeenCalledTimes(1);
    expect(reverse).toHaveBeenCalledWith('line-a');
    const orderUpdate = prisma.order.update.mock.calls.at(-1)[0];
    expect(orderUpdate.data.paymentStatus).toBeUndefined();
  });

  it('hides the shared payment intent after the other supplier line stays active', async () => {
    const { service } = harness();

    const result = await service.updateItemStatus(
      'ord-mixed',
      'line-a',
      { status: OrderStatus.CANCELLED },
      user(UserRole.SUPPLIER, 'sup-a'),
    );
    const body = JSON.stringify(result);

    expect(result.items.map((item) => item.id)).toEqual(['line-a']);
    expect(result.items[0].status).toBe(OrderStatus.CANCELLED);
    expect(result.total).toBe(43.5);
    expect(result).not.toHaveProperty('stripePaymentIntentId');
    expect(body).not.toContain('Atlas Lamp');
    expect(body).not.toContain('Driver B');
    expectSecretsAbsent(body);
  });
});
