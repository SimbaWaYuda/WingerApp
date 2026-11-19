import { OrderStatus, PaymentStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../commissions/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { FxService } from '../fx/fx.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { OrdersService } from './orders.service';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';
import { StripeService } from './stripe.service';

/**
 * Service-level checkout address contract.
 * Quote calls are observed and then executed, so the city argument and the
 * resulting fee label both come from the real fulfillment path.
 */

function customer(): AuthUser {
  return {
    sub: 'cust-1',
    email: 'amina@example.com',
    name: 'Amina',
    role: UserRole.CUSTOMER,
  };
}

function lamp() {
  return {
    id: 'p1',
    name: 'Lamp',
    brand: 'Savanna',
    price: 40,
    previousPrice: null,
    stock: 5,
    supplierId: 'sup-1',
    supplierName: 'Kijani',
    priceCurrency: 'USD',
    taxRatePercent: null,
    rating: 4.5,
    imageUrl: '',
    category: 'Home',
    model: null,
    color: null,
    size: null,
    battery: null,
    weight: null,
    description: null,
    variants: [],
    supplier: { verificationStatus: 'APPROVED' },
  };
}

function supplierRates() {
  return {
    id: 'sup-1',
    standardDeliveryFee: 4.99,
    expressDeliveryFee: 9.99,
    pickupDeliveryFee: 0,
    freeDeliveryThreshold: null,
    taxRatePercent: 8,
    taxOnDelivery: false,
    carrier: 'supplier',
    courierName: null,
    cityTaxes: [{ cityKey: 'dar es salaam', taxRatePercent: 18 }],
  };
}

function storedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    displayId: 'WG-10999',
    customerId: 'cust-1',
    customerName: 'Amina',
    customerEmail: 'amina@example.com',
    status: OrderStatus.PROCESSING,
    paymentStatus: PaymentStatus.PENDING,
    paymentMethod: 'card',
    paymentMode: 'test',
    stripePaymentIntentId: null as string | null,
    currency: 'USD',
    settlementCurrency: 'USD',
    subtotal: 40,
    taxAmount: 7.2,
    deliveryFee: 4.99,
    total: 52.19,
    paymentAmount: 52.19,
    paymentCurrency: 'USD',
    addressLine: 'Tegeta',
    city: 'Dar es Salaam',
    createdAt: new Date('2026-11-19T00:00:00.000Z'),
    items: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

describe('checkout address service', () => {
  let service: OrdersService;
  let prisma: any;
  let commissions: { createSnapshotsForOrder: jest.Mock };
  let stripe: {
    chargeOrder: jest.Mock;
    confirmPaymentIntent: jest.Mock;
    retrievePaymentIntentForWebhook: jest.Mock;
    checkoutMode: string;
  };
  let supplierPayments: { checkoutLipa: jest.Mock };
  let quotes: Array<{
    city?: string | null;
    deliveryMethod?: string;
    estimate?: string;
  }>;

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          displayCurrency: 'USD',
          phone: '',
        }),
        update: jest.fn(),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([lamp()]),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'p1',
          stock: 4,
          supplierId: 'sup-1',
        }),
        update: jest.fn().mockResolvedValue({ id: 'p1', stock: 4 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productVariant: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      supplier: {
        findMany: jest.fn().mockResolvedValue([supplierRates()]),
      },
      inventoryLedger: {
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    commissions = {
      createSnapshotsForOrder: jest.fn().mockResolvedValue({ created: 1, skipped: 0 }),
    };
    stripe = {
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      retrievePaymentIntentForWebhook: jest.fn(),
      checkoutMode: 'test',
    };
    supplierPayments = {
      checkoutLipa: jest.fn().mockResolvedValue({
        suppliers: [{ supplierId: 'sup-1' }],
      }),
    };
    const onboarding = {
      onOrderPlaced: jest.fn().mockResolvedValue(undefined),
    };
    const fx = {
      publicConfig: jest.fn().mockResolvedValue({ settlementCurrency: 'USD' }),
      normalize: (code: string) => code,
      quote: jest.fn().mockResolvedValue({
        baseCurrency: 'USD',
        quoteCurrency: 'USD',
        rate: 1,
        source: 'test',
        fetchedAt: '2026-11-19T00:00:00.000Z',
        expiresAt: '2026-11-20T00:00:00.000Z',
        fresh: true,
      }),
      resolvePaymentCurrency: jest.fn().mockResolvedValue('USD'),
    };
    service = new OrdersService(
      prisma,
      commissions as unknown as CommissionsService,
      stripe as unknown as StripeService,
      onboarding as unknown as OnboardingService,
      { notifyReturnStatusChange: jest.fn() } as unknown as NotificationsService,
      fx as unknown as FxService,
      { record: jest.fn() } as unknown as AuditService,
      {} as never,
      supplierPayments as never,
      {} as never,
      {} as never,
      new ShipmentRefundHoldService(prisma, {} as never, {} as never),
    );
    const original = (service as any).quoteFulfillment.bind(service);
    quotes = [];
    jest.spyOn(service as any, 'quoteFulfillment').mockImplementation(async (input: any) => {
      const quote = await original(input);
      quotes.push({
        city: input.city,
        deliveryMethod: input.deliveryMethod,
        estimate: quote.shipments?.[0]?.estimate,
      });
      return quote;
    });
    prisma.order.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'ord-new',
      displayId: 'WG-10025',
      customerId: 'cust-1',
      customerName: 'Amina',
      customerEmail: 'amina@example.com',
      customerPhone: null,
      status: OrderStatus.PROCESSING,
      paymentStatus: PaymentStatus.PENDING,
      paymentMethod: data.paymentMethod,
      paymentMode: data.paymentMode,
      stripePaymentIntentId: null,
      currency: 'USD',
      settlementCurrency: 'USD',
      subtotal: data.subtotal,
      taxAmount: data.taxAmount,
      deliveryFee: data.deliveryFee,
      total: data.total,
      paymentAmount: data.paymentAmount,
      paymentCurrency: data.paymentCurrency,
      addressLine: data.addressLine ?? null,
      city: data.city ?? null,
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      items: [],
    }));
  });

  function expectNoCheckoutMutations() {
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
    expect(stripe.chargeOrder).not.toHaveBeenCalled();
    expect(supplierPayments.checkoutLipa).not.toHaveBeenCalled();
    expect(quotes).toEqual([]);
    expect(prisma.supplier.findMany).not.toHaveBeenCalled();
  }

  describe('delivery address rejection', () => {
    it('rejects a missing street in validateCart before reading products', async () => {
      await expect(
        service.validateCart(
          {
            items: [{ productId: 'p1', quantity: 1 }],
            deliveryMethod: 'standard',
            addressLine: '   ',
            city: 'Dar es Salaam',
          },
          customer(),
        ),
      ).rejects.toThrow('Address is required for delivery');

      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expectNoCheckoutMutations();
    });

    it('rejects a missing city in validateCart before reading products', async () => {
      await expect(
        service.validateCart(
          {
            items: [{ productId: 'p1', quantity: 1 }],
            deliveryMethod: 'express',
            addressLine: 'Tegeta',
            city: '  ',
          },
          customer(),
        ),
      ).rejects.toThrow('City is required for delivery');

      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expectNoCheckoutMutations();
    });

    it.each(['card', 'cod', 'pay_on_delivery', 'lipa', 'pay_with_lipa'])(
      'create rejects a missing street for %s before payment or stock writes',
      async (paymentMethod) => {
        await expect(
          service.create(
            {
              items: [{ productId: 'p1', quantity: 1 }],
              deliveryMethod: 'standard',
              addressLine: '',
              city: 'Dar es Salaam',
              paymentMethod,
              stripePaymentMethodId: 'pm_card_address',
            },
            customer(),
          ),
        ).rejects.toThrow('Address is required for delivery');

        expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
        expectNoCheckoutMutations();
      },
    );

    it.each(['card', 'cod', 'pay_on_delivery', 'lipa', 'pay_with_lipa'])(
      'create rejects a missing city for %s before payment or stock writes',
      async (paymentMethod) => {
        await expect(
          service.create(
            {
              items: [{ productId: 'p1', quantity: 1 }],
              deliveryMethod: 'express',
              addressLine: 'Tegeta',
              city: undefined,
              paymentMethod,
              stripePaymentMethodId: 'pm_card_address',
            },
            customer(),
          ),
        ).rejects.toThrow('City is required for delivery');

        expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
        expectNoCheckoutMutations();
      },
    );
  });

  describe('pickup', () => {
    it('accepts a blank pickup address, stores null, and does not invent a destination', async () => {
      const result = await service.create(
        {
          items: [{ productId: 'p1', quantity: 1 }],
          deliveryMethod: 'pickup',
          addressLine: '   ',
          city: '   ',
          paymentMethod: 'cod',
        },
        customer(),
      );

      expect(quotes).toEqual([
        { city: undefined, deliveryMethod: 'pickup', estimate: 'Ready for pickup' },
      ]);
      expect(result.addressLine).toBeNull();
      expect(result.city).toBeNull();
      expect(result.deliveryFee).toBe(0);
      const inserted = prisma.order.create.mock.calls[0][0].data;
      expect(inserted.addressLine).toBeNull();
      expect(inserted.city).toBeNull();
      expect(inserted.deliveryFee.toString()).toBe('0');
      expect(prisma.product.updateMany).toHaveBeenCalledTimes(1);
      expect(stripe.chargeOrder).not.toHaveBeenCalled();
      expect(JSON.stringify(quotes)).not.toContain('Nairobi');
      expect(JSON.stringify(inserted)).not.toContain('Nairobi');
      expect(JSON.stringify(inserted)).not.toContain('Westlands');
    });

    it('validateCart keeps a blank pickup address null and quotes no destination', async () => {
      const result = await service.validateCart(
        {
          items: [{ productId: 'p1', quantity: 1 }],
          deliveryMethod: 'pickup',
          addressLine: ' ',
          city: ' ',
        },
        customer(),
      );

      expect(result.addressLine).toBeNull();
      expect(result.city).toBeNull();
      expect(result.deliveryFee).toBe(0);
      expect(result.shipments[0].estimate).toBe('Ready for pickup');
      expect(result.shipments[0].estimate).not.toContain('Nairobi');
      expect(quotes).toEqual([
        { city: undefined, deliveryMethod: 'pickup', estimate: 'Ready for pickup' },
      ]);
    });
  });

  describe('address and fee consistency', () => {
    const whitespaceAddress = {
      items: [{ productId: 'p1', quantity: 1 }],
      deliveryMethod: 'standard' as const,
      addressLine: '  Tegeta  ',
      city: '  Dar es Salaam  ',
    };

    it('validateCart quotes and returns the trimmed street and city', async () => {
      const result = await service.validateCart(whitespaceAddress, customer());

      expect(quotes).toEqual([
        {
          city: 'Dar es Salaam',
          deliveryMethod: 'standard',
          estimate: '3–5 days to Dar es Salaam',
        },
      ]);
      expect(result.addressLine).toBe('Tegeta');
      expect(result.city).toBe('Dar es Salaam');
      expect(result.tax).toBe(7.2);
      expect(result.deliveryFee).toBe(4.99);
      expect(result.shipments[0].estimate).toBe('3–5 days to Dar es Salaam');
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('create quotes the trimmed city and inserts that same street and city', async () => {
      const result = await service.create(
        { ...whitespaceAddress, paymentMethod: 'cod' },
        customer(),
      );

      expect(quotes).toEqual([
        {
          city: 'Dar es Salaam',
          deliveryMethod: 'standard',
          estimate: '3–5 days to Dar es Salaam',
        },
      ]);
      const inserted = prisma.order.create.mock.calls[0][0].data;
      expect(inserted.addressLine).toBe('Tegeta');
      expect(inserted.city).toBe('Dar es Salaam');
      expect(Number(inserted.taxAmount)).toBe(7.2);
      expect(Number(inserted.deliveryFee)).toBe(4.99);
      expect(result.addressLine).toBe('Tegeta');
      expect(result.city).toBe('Dar es Salaam');
      expect(result.tax).toBe(7.2);
      expect(commissions.createSnapshotsForOrder).toHaveBeenCalledTimes(1);
      expect(stripe.chargeOrder).not.toHaveBeenCalled();
      expect(JSON.stringify(inserted)).not.toContain('Nairobi');
      expect(JSON.stringify(inserted)).not.toContain('Westlands');
    });
  });

  describe('checkout replay', () => {
    it.each([
      ['cod', PaymentStatus.PENDING],
      ['lipa', PaymentStatus.PENDING],
      ['test', PaymentStatus.PAID],
    ] as const)(
      'returns the stored %s order when a replay omits the delivery address',
      async (paymentMode, paymentStatus) => {
        prisma.order.findUnique.mockResolvedValue(
          storedOrder({
            paymentMode,
            paymentStatus,
            addressLine: 'Tegeta',
            city: 'Dar es Salaam',
          }),
        );

        const result = await service.create(
          {
            items: [{ productId: 'p1', quantity: 1 }],
            paymentMethod: 'card',
            checkoutIdempotencyKey: 'replay-stored-1',
          },
          customer(),
        );

        expect(result.displayId).toBe('WG-10999');
        expect(result.addressLine).toBe('Tegeta');
        expect(result.city).toBe('Dar es Salaam');
        expect(prisma.product.findMany).not.toHaveBeenCalled();
        expectNoCheckoutMutations();
      },
    );

    it('sends a pending card replay to the existing charge path and does not apply the address rule', async () => {
      prisma.order.findUnique.mockResolvedValue(
        storedOrder({
          paymentStatus: PaymentStatus.PENDING,
          paymentMode: 'test',
          addressLine: 'Tegeta',
          city: 'Dar es Salaam',
        }),
      );
      const charge = jest
        .spyOn(service as any, 'chargeAndRecord')
        .mockResolvedValue({ id: 'ord-1', displayId: 'WG-10999', replayed: true });

      const result = await service.create(
        {
          items: [{ productId: 'p1', quantity: 1 }],
          paymentMethod: 'card',
          stripePaymentMethodId: 'pm_card_replay',
          checkoutIdempotencyKey: 'replay-pending-1',
        },
        customer(),
      );

      expect(result).toMatchObject({ id: 'ord-1', replayed: true });
      expect(charge).toHaveBeenCalledTimes(1);
      expect(charge.mock.calls[0][1]).toBe('pm_card_replay');
      expect(charge.mock.calls[0][3]).toEqual({ isRetry: true });
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(quotes).toEqual([]);
    });

    it('treats a failed replay without a payment intent as an already-failed checkout', async () => {
      prisma.order.findUnique.mockResolvedValue(
        storedOrder({
          paymentStatus: PaymentStatus.FAILED,
          paymentMode: 'test',
          stripePaymentIntentId: null,
        }),
      );

      await expect(
        service.create(
          {
            items: [{ productId: 'p1', quantity: 1 }],
            paymentMethod: 'card',
            checkoutIdempotencyKey: 'replay-failed-1',
          },
          customer(),
        ),
      ).rejects.toThrow('This checkout already failed. Start a new payment.');

      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expectNoCheckoutMutations();
    });

    it('reconciles a failed card replay that already has a PaymentIntent and ignores the missing address', async () => {
      const stored = storedOrder({
        paymentStatus: PaymentStatus.FAILED,
        paymentMode: 'test',
        stripePaymentIntentId: 'pi_bound',
        addressLine: 'Tegeta',
        city: 'Dar es Salaam',
      });
      prisma.order.findUnique.mockResolvedValue(stored);
      stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
        ok: true,
        intent: {
          id: 'pi_bound',
          status: 'canceled',
          amount: 5899,
          amountReceived: null,
          currency: 'usd',
          livemode: false,
          metadataOrderId: 'ord-1',
        },
      });

      await expect(
        service.create(
          {
            items: [{ productId: 'p1', quantity: 1 }],
            paymentMethod: 'card',
            stripePaymentMethodId: 'pm_card_visa',
            checkoutIdempotencyKey: 'replay-failed-bound',
          },
          customer(),
        ),
      ).rejects.toThrow('Stripe payment status: canceled');

      expect(stripe.retrievePaymentIntentForWebhook).toHaveBeenCalledWith('pi_bound');
      expect(stripe.confirmPaymentIntent).not.toHaveBeenCalled();
      expect(stripe.chargeOrder).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(stored.addressLine).toBe('Tegeta');
      expect(stored.city).toBe('Dar es Salaam');
      expect(prisma.product.findMany).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.product.updateMany).not.toHaveBeenCalled();
      expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
      expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
      expect(quotes).toEqual([]);
    });
  });
});
