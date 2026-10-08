import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommissionRecognitionStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  ReturnRefundStatus,
  ReturnRequestStatus,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { CommissionsService } from '../commissions/commissions.service';
import { FxService } from '../fx/fx.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from './stripe.service';

export type CreateOrderItemDto = {
  productId: string;
  quantity: number;
};

export type CreateOrderDto = {
  items: CreateOrderItemDto[];
  paymentMethod?: string;
  addressLine?: string;
  city?: string;
  /** express | standard | pickup */
  deliveryMethod?: string;
};

export type ValidateCartDto = {
  items: CreateOrderItemDto[];
  deliveryMethod?: string;
  city?: string;
};

export type UpdateItemStatusDto = {
  status?: OrderStatus;
  trackingCode?: string;
  pickupCode?: string;
  /** Collect COD payment (marks order PAID). */
  collectPayment?: boolean;
};

export type CreateReturnRequestDto = {
  orderItemId: string;
  reason: string;
  notes?: string;
  quantity?: number;
};

export type UpdateReturnRequestDto = {
  status?: ReturnRequestStatus;
  refundStatus?: ReturnRefundStatus;
  refundNote?: string;
};

const RETURN_REASONS = new Set([
  'damaged',
  'wrong_item',
  'not_as_described',
  'changed_mind',
  'other',
]);

const orderWithItems = {
  items: {
    include: {
      commission: true,
      replacesOrderItem: {
        select: {
          id: true,
          order: { select: { displayId: true } },
        },
      },
      replacedBy: {
        select: {
          id: true,
          order: { select: { displayId: true } },
        },
      },
    },
  },
} as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commissions: CommissionsService,
    private readonly stripe: StripeService,
    private readonly onboarding: OnboardingService,
    private readonly notifications: NotificationsService,
    private readonly fx: FxService,
  ) {}

  /**
   * Refresh trusted price/stock for cart lines without placing an order.
   * Clients must not trust local cached prices at checkout.
   */
  async validateCart(dto: ValidateCartDto, user: AuthUser) {
    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can validate a cart');
    }
    if (!dto.items?.length) {
      throw new BadRequestException('Cart is empty');
    }

    const quantities = new Map<string, number>();
    for (const item of dto.items) {
      const qty = Number(item.quantity);
      if (!item.productId || !Number.isFinite(qty) || qty < 1) {
        throw new BadRequestException('Invalid cart item');
      }
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + Math.floor(qty),
      );
    }

    const productIds = [...quantities.keys()];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { supplier: { select: { verificationStatus: true } } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));

    let subtotal = 0;
    let ok = true;
    const lines = productIds.map((productId) => {
      const requestedQty = quantities.get(productId)!;
      const product = byId.get(productId);
      if (!product) {
        ok = false;
        return {
          productId,
          available: false,
          reason: 'NOT_FOUND',
          requestedQty,
          availableQty: 0,
          unitPrice: 0,
          lineTotal: 0,
          product: null as null,
        };
      }

      const unitPrice = Number(product.price);
      const availableQty = product.stock;
      const clampedQty = Math.min(requestedQty, availableQty);
      const priceChanged = false; // client sends no price — server is source of truth
      const insufficient = requestedQty > availableQty || availableQty <= 0;
      if (insufficient) ok = false;

      const lineTotal = unitPrice * clampedQty;
      subtotal += lineTotal;

      return {
        productId,
        available: !insufficient,
        reason: insufficient
          ? availableQty <= 0
            ? 'OUT_OF_STOCK'
            : 'INSUFFICIENT_STOCK'
          : null,
        requestedQty,
        availableQty,
        unitPrice,
        previousPrice:
          product.previousPrice == null
            ? null
            : Number(product.previousPrice),
        lineTotal,
        priceChanged,
        product: {
          id: product.id,
          name: product.name,
          brand: product.brand,
          supplierId: product.supplierId,
          supplierName: product.supplierName,
          supplierVerified:
            product.supplier?.verificationStatus === 'APPROVED' ||
            product.supplier?.verificationStatus === 'VERIFIED',
          price: unitPrice,
          previousPrice:
            product.previousPrice == null
              ? undefined
              : Number(product.previousPrice),
          rating: product.rating,
          imageUrl: product.imageUrl,
          category: product.category,
          model: product.model,
          color: product.color,
          size: product.size,
          battery: product.battery,
          weight: product.weight,
          description: product.description,
          stock: product.stock,
          stockStatus:
            product.stockStatus === StockStatus.LOW_STOCK
              ? 'lowStock'
              : product.stockStatus === StockStatus.OUT_OF_STOCK
                ? 'outOfStock'
                : 'inStock',
        },
      };
    });

    const supplierNames = [
      ...new Set(
        lines
          .map((line) => line.product?.supplierName)
          .filter((name): name is string => !!name),
      ),
    ];
    const fees = computeFulfillmentFees({
      subtotal,
      deliveryMethod: dto.deliveryMethod,
      city: dto.city,
      supplierNames,
    });
    const fxConfig = await this.fx.publicConfig();
    const settlement = fxConfig.settlementCurrency;
    const profile = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { displayCurrency: true },
    });
    const display = this.fx.normalize(profile?.displayCurrency || settlement);
    let displayQuote: {
      currency: string;
      rate: number;
      subtotal: number;
      tax: number;
      deliveryFee: number;
      total: number;
      estimate: boolean;
      paymentCurrency: string;
      expiresAt: string;
    } | null = null;
    let fxError: string | null = null;
    try {
      const quote = await this.fx.quote(settlement, display);
      const paymentCurrency = await this.fx.resolvePaymentCurrency(
        display,
        settlement,
      );
      displayQuote = {
        currency: display,
        rate: quote.rate,
        subtotal: roundMoney(fees.subtotal * quote.rate),
        tax: roundMoney(fees.tax * quote.rate),
        deliveryFee: roundMoney(fees.deliveryFee * quote.rate),
        total: roundMoney(fees.total * quote.rate),
        estimate: display !== paymentCurrency,
        paymentCurrency,
        expiresAt: quote.expiresAt,
      };
    } catch (error) {
      fxError = error instanceof Error ? error.message : 'Exchange rate unavailable';
    }

    return {
      ok,
      currency: settlement,
      settlementCurrency: settlement,
      subtotal: fees.subtotal,
      deliveryFee: fees.deliveryFee,
      tax: fees.tax,
      total: fees.total,
      display: displayQuote,
      fxError,
      deliveryMethod: fees.deliveryMethod,
      shipments: fees.shipments,
      lines,
    };
  }

  async create(dto: CreateOrderDto, user: AuthUser) {
    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can place orders');
    }
    if (!dto.items?.length) {
      throw new BadRequestException('Cart is empty');
    }

    const quantities = new Map<string, number>();
    for (const item of dto.items) {
      const qty = Number(item.quantity);
      if (!item.productId || !Number.isFinite(qty) || qty < 1) {
        throw new BadRequestException('Invalid cart item');
      }
      quantities.set(
        item.productId,
        (quantities.get(item.productId) ?? 0) + Math.floor(qty),
      );
    }

    const productIds = [...quantities.keys()];
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException('One or more products were not found');
    }

    for (const product of products) {
      const qty = quantities.get(product.id)!;
      if (product.stock < qty) {
        throw new BadRequestException(
          `Insufficient stock for ${product.name} (have ${product.stock}, need ${qty})`,
        );
      }
    }

    const lines = products.map((product) => {
      const quantity = quantities.get(product.id)!;
      const unitPrice = product.price;
      const lineTotal = new Prisma.Decimal(unitPrice).mul(quantity);
      return { product, quantity, unitPrice, lineTotal };
    });
    const subtotal = lines.reduce(
      (sum, line) => sum.add(line.lineTotal),
      new Prisma.Decimal(0),
    );
    const supplierNames = [
      ...new Set(products.map((product) => product.supplierName)),
    ];
    const fees = computeFulfillmentFees({
      subtotal: Number(subtotal),
      deliveryMethod: dto.deliveryMethod,
      city: dto.city,
      supplierNames,
    });
    const total = new Prisma.Decimal(fees.total.toFixed(2));
    const payOnDelivery = isPayOnDelivery(dto.paymentMethod);
    const deliveryMethod = normalizeDeliveryMethod(dto.deliveryMethod);
    const addressLine = (dto.addressLine ?? '').trim();
    const city = (dto.city ?? '').trim();
    if (payOnDelivery && deliveryMethod !== 'pickup') {
      if (!addressLine || !city) {
        throw new BadRequestException(
          'Address and city are required for pay on delivery',
        );
      }
    }

    const fxConfig = await this.fx.publicConfig();
    const settlementCurrency = fxConfig.settlementCurrency;
    const profile = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { displayCurrency: true },
    });
    const displayCurrency = this.fx.normalize(
      profile?.displayCurrency || settlementCurrency,
    );
    // Throws if the display rate is missing or expired. Identity rate when equal.
    const fxQuote = await this.fx.quote(settlementCurrency, displayCurrency);
    const paymentCurrency = await this.fx.resolvePaymentCurrency(
      displayCurrency,
      settlementCurrency,
    );
    const displaySubtotal = roundMoney(fees.subtotal * fxQuote.rate);
    const displayTax = roundMoney(fees.tax * fxQuote.rate);
    const displayDelivery = roundMoney(fees.deliveryFee * fxQuote.rate);
    const displayTotal = roundMoney(
      displaySubtotal + displayTax + displayDelivery,
    );
    const paymentAmount =
      paymentCurrency === displayCurrency ? displayTotal : fees.total;

    const order = await this.prisma.$transaction(async (tx) => {
      const count = await tx.order.count();
      const displayId = `WG-${10025 + count}`;

      const created = await tx.order.create({
        data: {
          displayId,
          customerId: user.sub,
          customerName: user.name,
          customerEmail: user.email,
          status: OrderStatus.PROCESSING,
          paymentStatus: PaymentStatus.PENDING,
          paymentMethod: payOnDelivery
            ? 'pay_on_delivery'
            : (dto.paymentMethod ?? 'card'),
          paymentMode: payOnDelivery
            ? 'cod'
            : this.stripe.configured
              ? 'stripe'
              : 'demo',
          currency: settlementCurrency,
          settlementCurrency,
          displayCurrency,
          displaySubtotal: new Prisma.Decimal(displaySubtotal.toFixed(2)),
          displayTaxAmount: new Prisma.Decimal(displayTax.toFixed(2)),
          displayDeliveryFee: new Prisma.Decimal(displayDelivery.toFixed(2)),
          displayTotal: new Prisma.Decimal(displayTotal.toFixed(2)),
          paymentCurrency,
          paymentAmount: new Prisma.Decimal(paymentAmount.toFixed(2)),
          fxRate: new Prisma.Decimal(fxQuote.rate.toFixed(8)),
          fxBaseCurrency: fxQuote.baseCurrency,
          fxQuoteCurrency: fxQuote.quoteCurrency,
          fxFetchedAt: new Date(fxQuote.fetchedAt),
          fxExpiresAt: new Date(fxQuote.expiresAt),
          fxSource: fxQuote.source,
          subtotal,
          taxAmount: new Prisma.Decimal(fees.tax.toFixed(2)),
          deliveryFee: new Prisma.Decimal(fees.deliveryFee.toFixed(2)),
          total,
          addressLine: addressLine || 'Westlands',
          city: city || 'Nairobi',
          items: {
            create: lines.map((line) => ({
              productId: line.product.id,
              productName: line.product.name,
              supplierId: line.product.supplierId,
              supplierName: line.product.supplierName,
              unitPrice: line.unitPrice,
              priceCurrency: line.product.priceCurrency || settlementCurrency,
              displayUnitPrice: new Prisma.Decimal(
                roundMoney(Number(line.unitPrice) * fxQuote.rate).toFixed(2),
              ),
              displayLineTotal: new Prisma.Decimal(
                roundMoney(Number(line.lineTotal) * fxQuote.rate).toFixed(2),
              ),
              quantity: line.quantity,
              lineTotal: line.lineTotal,
              status: OrderStatus.PROCESSING,
            })),
          },
        },
        include: orderWithItems,
      });

      for (const line of lines) {
        const reserved = await tx.product.updateMany({
          where: {
            id: line.product.id,
            stock: { gte: line.quantity },
          },
          data: { stock: { decrement: line.quantity } },
        });
        if (reserved.count === 0) {
          throw new BadRequestException(
            `Insufficient stock for ${line.product.name}`,
          );
        }
        const product = await tx.product.findUniqueOrThrow({
          where: { id: line.product.id },
        });
        await tx.product.update({
          where: { id: product.id },
          data: { stockStatus: stockStatusFor(product.stock) },
        });
        await tx.inventoryLedger.create({
          data: {
            productId: line.product.id,
            supplierId: line.product.supplierId,
            delta: -line.quantity,
            reason: 'ORDER_SALE',
            eventId: `order-${created.id}-${line.product.id}`,
            userId: user.sub,
            quantityAfter: product.stock,
          },
        });
      }

      return created;
    });

    if (payOnDelivery) {
      // COD: snapshot at confirmation as PENDING; settle later on delivery + payment.
      await this.commissions.createSnapshotsForOrder({
        orderId: order.id,
        paymentMode: 'cod',
        isDemo: false,
        initialStatus: CommissionRecognitionStatus.PENDING,
      });
      await this.onboarding.onOrderPlaced(user.sub, user.role);
      return this.toResponse(
        order,
        'Pay on delivery — collect payment when the order is delivered',
      );
    }

    const amountCents = Math.round(Number(paymentAmount) * 100);
    const charge = await this.stripe.chargeOrder({
      amountCents,
      currency: paymentCurrency.toLowerCase(),
      orderDisplayId: order.displayId,
      customerEmail: user.email,
    });

    const paymentStatus =
      charge.status === 'paid' ? PaymentStatus.PAID : PaymentStatus.FAILED;

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus,
        paymentMode: charge.mode,
        stripePaymentIntentId: charge.paymentIntentId,
        status:
          paymentStatus === PaymentStatus.FAILED
            ? OrderStatus.CANCELLED
            : OrderStatus.PROCESSING,
      },
      include: orderWithItems,
    });

    if (paymentStatus === PaymentStatus.FAILED) {
      await this.restoreStock(updated.id, user.sub);
      throw new BadRequestException(charge.message);
    }

    // Card/demo: snapshot at payment confirmation. Demo is flagged and never settleable.
    const isDemo = charge.mode === 'demo';
    await this.commissions.createSnapshotsForOrder({
      orderId: updated.id,
      paymentMode: charge.mode,
      isDemo,
      initialStatus: CommissionRecognitionStatus.RECOGNIZED,
    });

    await this.onboarding.onOrderPlaced(user.sub, user.role);
    return this.toResponse(updated, charge.message);
  }

  /** Platform KPIs from live orders. Money fields are settlement USD. */
  async getAdminDashboard(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin account required');
    }

    const openStatuses = [
      OrderStatus.PROCESSING,
      OrderStatus.READY_FOR_PICKUP,
      OrderStatus.PARTIAL,
    ];

    const [gmv, orderCount, paidCount, openCount, commissions, activeSuppliers, supplierCount, openReturns, deliveryExceptions, unpaidOrders] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: { status: { not: OrderStatus.CANCELLED } },
          _sum: { subtotal: true },
        }),
        this.prisma.order.count({
          where: { status: { not: OrderStatus.CANCELLED } },
        }),
        this.prisma.order.count({
          where: {
            status: { not: OrderStatus.CANCELLED },
            paymentStatus: PaymentStatus.PAID,
          },
        }),
        this.prisma.order.count({
          where: { status: { in: openStatuses } },
        }),
        this.prisma.orderItemCommission.findMany({
          where: {
            isDemo: false,
            status: { not: CommissionRecognitionStatus.CLAWED_BACK },
          },
          select: { commissionAmount: true, status: true },
        }),
        this.prisma.orderItem.groupBy({
          by: ['supplierId'],
          where: { status: { not: OrderStatus.CANCELLED } },
        }),
        this.prisma.supplier.count(),
        this.prisma.returnRequest.count({
          where: {
            status: {
              in: [ReturnRequestStatus.REQUESTED, ReturnRequestStatus.IN_REVIEW],
            },
          },
        }),
        this.prisma.orderItem.count({
          where: {
            order: { status: { not: OrderStatus.CANCELLED } },
            OR: [
              { status: OrderStatus.RETURNED },
              {
                status: OrderStatus.SHIPPED,
                OR: [{ trackingCode: null }, { trackingCode: '' }],
              },
            ],
          },
        }),
        this.prisma.order.count({
          where: {
            status: { not: OrderStatus.CANCELLED },
            paymentStatus: PaymentStatus.PENDING,
          },
        }),
      ]);

    let wingerRevenue = 0;
    let settleableCommission = 0;
    for (const row of commissions) {
      const amount = Number(row.commissionAmount);
      wingerRevenue += amount;
      if (row.status === CommissionRecognitionStatus.SETTLEABLE) {
        settleableCommission += amount;
      }
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      currency: 'USD',
      gmv: round(Number(gmv._sum.subtotal ?? 0)),
      wingerRevenue: round(wingerRevenue),
      settleableCommission: round(settleableCommission),
      orderCount,
      paidCount,
      openCount,
      activeSuppliers: activeSuppliers.length,
      supplierCount,
      openReturns,
      deliveryExceptions,
      unpaidOrders,
    };
  }

  /** Supplier rows for the admin list. Sales are settlement USD. */
  async getAdminSuppliers(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin account required');
    }

    const [suppliers, items] = await Promise.all([
      this.prisma.supplier.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.orderItem.findMany({
        where: { status: { not: OrderStatus.CANCELLED } },
        select: { supplierId: true, orderId: true, lineTotal: true },
      }),
    ]);

    const bySupplier = new Map<string, { orders: Set<string>; grossSales: number }>();
    for (const item of items) {
      const bucket = bySupplier.get(item.supplierId) ?? {
        orders: new Set<string>(),
        grossSales: 0,
      };
      bucket.orders.add(item.orderId);
      bucket.grossSales += Number(item.lineTotal);
      bySupplier.set(item.supplierId, bucket);
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return suppliers.map((supplier) => {
      const bucket = bySupplier.get(supplier.id);
      return {
        id: supplier.id,
        name: supplier.name,
        verificationStatus: supplier.verificationStatus,
        orderCount: bucket?.orders.size ?? 0,
        grossSales: round(bucket?.grossSales ?? 0),
        currency: 'USD',
      };
    });
  }

  /** Shipment counts for the admin delivery tab. Line values are settlement USD. */
  async getAdminDelivery(user: AuthUser) {
    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Admin account required');
    }

    const items = await this.prisma.orderItem.findMany({
      where: {
        status: { not: OrderStatus.CANCELLED },
        order: { status: { not: OrderStatus.CANCELLED } },
      },
      select: {
        id: true,
        productName: true,
        supplierName: true,
        status: true,
        lineTotal: true,
        quantity: true,
        trackingCode: true,
        order: { select: { id: true, displayId: true, createdAt: true } },
      },
    });

    let inTransit = 0;
    let inTransitValue = 0;
    let pickupReady = 0;
    let pickupReadyValue = 0;
    let exceptions = 0;
    let exceptionValue = 0;
    const shipments: Array<{
      id: string;
      orderId: string;
      displayId: string;
      supplierName: string;
      productName: string;
      quantity: number;
      status: OrderStatus;
      lineTotal: number;
      trackingCode: string | null;
      createdAt: Date;
    }> = [];

    for (const item of items) {
      const amount = Number(item.lineTotal);
      const missingTracking =
        item.status === OrderStatus.SHIPPED && !item.trackingCode?.trim();
      const isException = item.status === OrderStatus.RETURNED || missingTracking;
      if (item.status === OrderStatus.SHIPPED) {
        inTransit += 1;
        inTransitValue += amount;
      } else if (item.status === OrderStatus.READY_FOR_PICKUP) {
        pickupReady += 1;
        pickupReadyValue += amount;
      }
      if (isException) {
        exceptions += 1;
        exceptionValue += amount;
      }
      if (
        item.status === OrderStatus.SHIPPED ||
        item.status === OrderStatus.READY_FOR_PICKUP ||
        item.status === OrderStatus.RETURNED
      ) {
        shipments.push({
          id: item.id,
          orderId: item.order.id,
          displayId: item.order.displayId,
          supplierName: item.supplierName,
          productName: item.productName,
          quantity: item.quantity,
          status: item.status,
          lineTotal: Math.round(amount * 100) / 100,
          trackingCode: item.trackingCode,
          createdAt: item.order.createdAt,
        });
      }
    }

    shipments.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      currency: 'USD',
      inTransit,
      inTransitValue: round(inTransitValue),
      pickupReady,
      pickupReadyValue: round(pickupReadyValue),
      exceptions,
      exceptionValue: round(exceptionValue),
      shipments: shipments.slice(0, 40).map(({ createdAt: _createdAt, ...row }) => row),
    };
  }

  async list(user: AuthUser) {
    if (user.role === UserRole.CUSTOMER) {
      const orders = await this.prisma.order.findMany({
        where: { customerId: user.sub },
        include: orderWithItems,
        orderBy: { createdAt: 'desc' },
      });
      return orders.map((order) => this.toResponse(order));
    }

    if (user.role === UserRole.SUPPLIER) {
      if (!user.supplierId) {
        throw new ForbiddenException('Supplier account is missing supplierId');
      }
      const orders = await this.prisma.order.findMany({
        where: {
          items: { some: { supplierId: user.supplierId } },
          status: { not: OrderStatus.CANCELLED },
          OR: [
            { paymentStatus: PaymentStatus.PAID },
            {
              paymentMode: 'cod',
              paymentStatus: PaymentStatus.PENDING,
            },
          ],
        },
        include: {
          items: { where: { supplierId: user.supplierId } },
        },
        orderBy: { createdAt: 'desc' },
      });
      return orders.map((order) => this.toResponse(order));
    }

    const orders = await this.prisma.order.findMany({
      include: orderWithItems,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return orders.map((order) => this.toResponse(order));
  }

  async findOne(id: string, user: AuthUser) {
    const order = await this.prisma.order.findFirst({
      where: {
        OR: [{ id }, { displayId: id }],
      },
      include: orderWithItems,
    });
    if (!order) throw new NotFoundException('Order not found');
    this.assertCanView(order, user);
    const base = this.toResponse(order);
    const returnRequests = await this.listReturnRequests(order.id, user);
    if (user.role !== UserRole.CUSTOMER || order.customerId !== user.sub) {
      return { ...base, returnRequests };
    }
    const canRateSuppliers = await this.listRateableSuppliers(order, user.sub);
    const returnableItems = await this.listReturnableItems(order);
    return { ...base, canRateSuppliers, returnRequests, returnableItems };
  }

  /**
   * Customer return / support request for a delivered line item.
   * Records the request only — no refund or stock restore yet.
   */
  async createReturnRequest(
    orderId: string,
    dto: CreateReturnRequestDto,
    user: AuthUser,
  ) {
    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can request returns');
    }
    const reason = (dto.reason ?? '').trim().toLowerCase();
    if (!RETURN_REASONS.has(reason)) {
      throw new BadRequestException(
        `Reason must be one of: ${[...RETURN_REASONS].join(', ')}`,
      );
    }
    const notes = dto.notes?.trim() || null;
    if (notes && notes.length > 500) {
      throw new BadRequestException('Notes must be 500 characters or fewer');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        OR: [{ id: orderId }, { displayId: orderId }],
        customerId: user.sub,
      },
      include: orderWithItems,
    });
    if (!order) throw new NotFoundException('Order not found');

    const item = order.items.find((row) => row.id === dto.orderItemId);
    if (!item) {
      throw new BadRequestException('Item is not part of this order');
    }
    if (item.status !== OrderStatus.DELIVERED) {
      throw new BadRequestException(
        'Returns are only available after the item is delivered',
      );
    }

    const open = await this.prisma.returnRequest.findFirst({
      where: {
        orderItemId: item.id,
        status: {
          in: [ReturnRequestStatus.REQUESTED, ReturnRequestStatus.IN_REVIEW],
        },
      },
    });
    if (open) {
      throw new BadRequestException(
        'A return request is already open for this item',
      );
    }

    const quantity = dto.quantity != null ? Number(dto.quantity) : item.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.quantity) {
      throw new BadRequestException(
        `Quantity must be an integer from 1 to ${item.quantity}`,
      );
    }

    const created = await this.prisma.returnRequest.create({
      data: {
        orderId: order.id,
        orderItemId: item.id,
        customerId: user.sub,
        reason,
        notes,
        quantity,
      },
      include: {
        order: { select: { displayId: true } },
        orderItem: {
          select: { productName: true, supplierName: true },
        },
      },
    });

    return this.toReturnResponse(created);
  }

  /** Supplier/admin inbox of return requests. Optional `status` CSV filter. */
  async listReturnsInbox(user: AuthUser, statusCsv?: string) {
    if (user.role !== UserRole.SUPPLIER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only suppliers or admins can list returns');
    }
    if (user.role === UserRole.SUPPLIER && !user.supplierId) {
      throw new ForbiddenException('Supplier account is not linked');
    }

    const statuses = (statusCsv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean) as ReturnRequestStatus[];
    for (const status of statuses) {
      if (!Object.values(ReturnRequestStatus).includes(status)) {
        throw new BadRequestException(`Invalid return status: ${status}`);
      }
    }

    const rows = await this.prisma.returnRequest.findMany({
      where: {
        ...(user.role === UserRole.SUPPLIER
          ? { orderItem: { supplierId: user.supplierId! } }
          : {}),
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        order: { select: { displayId: true, customerName: true } },
        orderItem: {
          select: { productName: true, supplierName: true, supplierId: true },
        },
      },
    });

    return rows.map((row) => ({
      ...this.toReturnResponse(row),
      customerName: row.order.customerName,
    }));
  }

  /**
   * Returns/refunds KPIs. Admin = platform-wide; supplier = own lines only.
   */
  async listReturnsOverview(user: AuthUser) {
    if (user.role !== UserRole.ADMIN && user.role !== UserRole.SUPPLIER) {
      throw new ForbiddenException(
        'Only suppliers or admins can view returns overview',
      );
    }
    if (user.role === UserRole.SUPPLIER && !user.supplierId) {
      throw new ForbiddenException('Supplier account is not linked');
    }

    const scope =
      user.role === UserRole.SUPPLIER
        ? { orderItem: { supplierId: user.supplierId! } }
        : {};

    const [byStatus, byRefund, pendingRefundRows, openRows] =
      await Promise.all([
        this.prisma.returnRequest.groupBy({
          by: ['status'],
          where: scope,
          _count: { _all: true },
        }),
        this.prisma.returnRequest.groupBy({
          by: ['refundStatus'],
          where: scope,
          _count: { _all: true },
        }),
        this.prisma.returnRequest.findMany({
          where: {
            ...scope,
            refundStatus: ReturnRefundStatus.PENDING,
            status: {
              in: [ReturnRequestStatus.APPROVED, ReturnRequestStatus.CLOSED],
            },
          },
          select: {
            orderItem: { select: { supplierId: true, supplierName: true } },
          },
        }),
        this.prisma.returnRequest.findMany({
          where: {
            ...scope,
            status: {
              in: [
                ReturnRequestStatus.REQUESTED,
                ReturnRequestStatus.IN_REVIEW,
              ],
            },
          },
          select: {
            orderItem: { select: { supplierId: true, supplierName: true } },
          },
        }),
      ]);

    const statusCounts: Record<string, number> = {};
    for (const row of byStatus) {
      statusCounts[row.status] = row._count._all;
    }
    const refundCounts: Record<string, number> = {};
    for (const row of byRefund) {
      refundCounts[row.refundStatus] = row._count._all;
    }

    const openCount =
      (statusCounts[ReturnRequestStatus.REQUESTED] ?? 0) +
      (statusCounts[ReturnRequestStatus.IN_REVIEW] ?? 0);
    const pendingRefunds = pendingRefundRows.length;
    const refundsIssued = refundCounts[ReturnRefundStatus.ISSUED] ?? 0;
    const rejected = statusCounts[ReturnRequestStatus.REJECTED] ?? 0;
    const approved = statusCounts[ReturnRequestStatus.APPROVED] ?? 0;

    type SupplierBucket = {
      supplierId: string;
      supplierName: string;
      openReturns: number;
      pendingRefunds: number;
    };
    const bySupplier = new Map<string, SupplierBucket>();
    const bump = (
      supplierId: string,
      supplierName: string,
      field: 'openReturns' | 'pendingRefunds',
    ) => {
      const cur = bySupplier.get(supplierId) ?? {
        supplierId,
        supplierName,
        openReturns: 0,
        pendingRefunds: 0,
      };
      cur[field] += 1;
      if (supplierName) cur.supplierName = supplierName;
      bySupplier.set(supplierId, cur);
    };

    // Admin-only breakdown across suppliers.
    let suppliers: SupplierBucket[] = [];
    if (user.role === UserRole.ADMIN) {
      for (const row of openRows) {
        bump(row.orderItem.supplierId, row.orderItem.supplierName, 'openReturns');
      }
      for (const row of pendingRefundRows) {
        bump(
          row.orderItem.supplierId,
          row.orderItem.supplierName,
          'pendingRefunds',
        );
      }
      suppliers = [...bySupplier.values()]
        .sort(
          (a, b) =>
            b.openReturns +
            b.pendingRefunds -
            (a.openReturns + a.pendingRefunds),
        )
        .slice(0, 12);
    }

    return {
      scope: user.role === UserRole.ADMIN ? 'platform' : 'supplier',
      openReturns: openCount,
      pendingRefunds,
      refundsIssued,
      approvedReturns: approved,
      rejectedReturns: rejected,
      byStatus: statusCounts,
      byRefundStatus: refundCounts,
      suppliers,
    };
  }

  /**
   * Create a no-charge replacement order for a RETURNED line.
   * Stock is reserved again; customer is not re-charged; no new commission snapshot.
   */
  async createReplacementOrder(
    orderId: string,
    itemId: string,
    user: AuthUser,
    quantity?: number,
  ) {
    if (user.role !== UserRole.SUPPLIER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only suppliers or admins can create replacements',
      );
    }

    const source = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: {
        order: true,
        product: true,
        replacedBy: { select: { id: true, order: { select: { displayId: true } } } },
      },
    });
    if (
      !source ||
      (source.orderId !== orderId && source.order.displayId !== orderId)
    ) {
      throw new NotFoundException('Order item not found');
    }
    if (
      user.role === UserRole.SUPPLIER &&
      source.supplierId !== user.supplierId
    ) {
      throw new ForbiddenException('Cannot replace another supplier item');
    }
    if (source.status !== OrderStatus.RETURNED) {
      throw new BadRequestException(
        'Only returned order lines can be replaced',
      );
    }
    if (source.replacedBy) {
      throw new BadRequestException(
        `A replacement already exists (${source.replacedBy.order.displayId})`,
      );
    }

    const qty =
      quantity != null ? Math.floor(Number(quantity)) : source.quantity;
    if (!Number.isFinite(qty) || qty < 1) {
      throw new BadRequestException('quantity must be a positive integer');
    }
    if (qty > source.quantity) {
      throw new BadRequestException(
        `Replacement quantity cannot exceed original (${source.quantity})`,
      );
    }
    if (source.product.stock < qty) {
      throw new BadRequestException(
        `Insufficient stock for ${source.product.name} (have ${source.product.stock}, need ${qty})`,
      );
    }

    const unitPrice = source.product.price;
    const lineTotal = new Prisma.Decimal(unitPrice).mul(qty);

    const replacement = await this.prisma.$transaction(async (tx) => {
      const count = await tx.order.count();
      const displayId = `WG-${10025 + count}`;
      const created = await tx.order.create({
        data: {
          displayId,
          customerId: source.order.customerId,
          customerName: source.order.customerName,
          customerEmail: source.order.customerEmail,
          status: OrderStatus.PROCESSING,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: 'replacement',
          paymentMode: 'replacement',
          currency: source.order.currency,
          settlementCurrency: source.order.settlementCurrency || source.order.currency,
          paymentCurrency: source.order.settlementCurrency || source.order.currency,
          paymentAmount: lineTotal,
          subtotal: lineTotal,
          taxAmount: new Prisma.Decimal(0),
          deliveryFee: new Prisma.Decimal(0),
          total: lineTotal,
          addressLine: source.order.addressLine,
          city: source.order.city,
          items: {
            create: {
              productId: source.productId,
              productName: source.product.name,
              supplierId: source.supplierId,
              supplierName: source.supplierName,
              unitPrice,
              quantity: qty,
              lineTotal,
              status: OrderStatus.PROCESSING,
              replacesOrderItemId: source.id,
            },
          },
        },
        include: orderWithItems,
      });

      const nextStock = source.product.stock - qty;
      await tx.product.update({
        where: { id: source.productId },
        data: {
          stock: nextStock,
          stockStatus: stockStatusFor(nextStock),
        },
      });
      await tx.inventoryLedger.create({
        data: {
          productId: source.productId,
          supplierId: source.supplierId,
          delta: -qty,
          reason: 'REPLACEMENT_ORDER',
          eventId: `replacement-${created.id}-${source.id}`,
          userId: user.sub,
          quantityAfter: nextStock,
        },
      });

      // Exchange path: approved return no longer needs a cash refund.
      await tx.returnRequest.updateMany({
        where: {
          orderItemId: source.id,
          status: {
            in: [ReturnRequestStatus.APPROVED, ReturnRequestStatus.CLOSED],
          },
          refundStatus: {
            in: [ReturnRefundStatus.NONE, ReturnRefundStatus.PENDING],
          },
        },
        data: {
          refundStatus: ReturnRefundStatus.NOT_REQUIRED,
          refundNote: `Handled via replacement ${displayId}`,
        },
      });

      return created;
    });

    return {
      ...this.toResponse(
        replacement,
        `Replacement order ${replacement.displayId} created for ${source.order.displayId}`,
      ),
      replacesOrderId: source.order.displayId,
      replacesOrderItemId: source.id,
    };
  }

  /**
   * Supplier/admin review of a return request and/or manual refund tracking.
   * APPROVED marks the line RETURNED and restores stock for the returned qty.
   * Refund money movement stays manual; Slice 5b records ISSUED/PENDING status.
   */
  async updateReturnRequest(
    returnId: string,
    dto: UpdateReturnRequestDto,
    user: AuthUser,
  ) {
    if (user.role !== UserRole.SUPPLIER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only suppliers or admins can review returns');
    }
    if (dto.status == null && dto.refundStatus == null) {
      throw new BadRequestException('status or refundStatus is required');
    }
    if (
      dto.status != null &&
      !Object.values(ReturnRequestStatus).includes(dto.status)
    ) {
      throw new BadRequestException('Invalid return status');
    }
    if (
      dto.refundStatus != null &&
      !Object.values(ReturnRefundStatus).includes(dto.refundStatus)
    ) {
      throw new BadRequestException('Invalid refund status');
    }

    const row = await this.prisma.returnRequest.findUnique({
      where: { id: returnId },
      include: {
        order: { select: { displayId: true, id: true } },
        orderItem: true,
      },
    });
    if (!row) throw new NotFoundException('Return request not found');

    if (
      user.role === UserRole.SUPPLIER &&
      row.orderItem.supplierId !== user.supplierId
    ) {
      throw new ForbiddenException('Cannot review another supplier return');
    }

    if (dto.status != null) {
      const next = dto.status;
      this.assertReturnTransition(row.status, next);

      if (next === ReturnRequestStatus.APPROVED) {
        if (row.orderItem.status !== OrderStatus.DELIVERED) {
          throw new BadRequestException(
            'Only delivered items can be approved for return',
          );
        }
        await this.prisma.$transaction(async (tx) => {
          await tx.returnRequest.update({
            where: { id: row.id },
            data: {
              status: next,
              refundStatus:
                row.refundStatus === ReturnRefundStatus.NONE
                  ? ReturnRefundStatus.PENDING
                  : row.refundStatus,
            },
          });
          await tx.orderItem.update({
            where: { id: row.orderItemId },
            data: { status: OrderStatus.RETURNED },
          });
          const product = await tx.product.findUnique({
            where: { id: row.orderItem.productId },
          });
          if (product) {
            const nextStock = product.stock + row.quantity;
            await tx.product.update({
              where: { id: product.id },
              data: { stock: nextStock, stockStatus: stockStatusFor(nextStock) },
            });
            await tx.inventoryLedger.create({
              data: {
                productId: product.id,
                supplierId: product.supplierId,
                delta: row.quantity,
                reason: 'RETURN_APPROVED',
                eventId: `return-restore-${row.id}-${Date.now()}`,
                userId: user.sub,
                quantityAfter: nextStock,
              },
            });
          }
          const items = await tx.orderItem.findMany({
            where: { orderId: row.orderId },
            select: { status: true },
          });
          await tx.order.update({
            where: { id: row.orderId },
            data: { status: rollupStatus(items.map((item) => item.status)) },
          });
        });
      } else {
        await this.prisma.returnRequest.update({
          where: { id: row.id },
          data: {
            status: next,
            ...(next === ReturnRequestStatus.REJECTED &&
            row.refundStatus === ReturnRefundStatus.NONE
              ? { refundStatus: ReturnRefundStatus.NOT_REQUIRED }
              : {}),
          },
        });
      }
    }

    if (dto.refundStatus != null) {
      const current = await this.prisma.returnRequest.findUnique({
        where: { id: row.id },
      });
      if (!current) throw new NotFoundException('Return request not found');
      if (
        current.status !== ReturnRequestStatus.APPROVED &&
        current.status !== ReturnRequestStatus.CLOSED &&
        dto.refundStatus !== ReturnRefundStatus.NOT_REQUIRED
      ) {
        throw new BadRequestException(
          'Refund status can only be set after a return is approved',
        );
      }
      const becameIssued =
        dto.refundStatus === ReturnRefundStatus.ISSUED &&
        current.refundStatus !== ReturnRefundStatus.ISSUED;
      await this.prisma.returnRequest.update({
        where: { id: row.id },
        data: {
          refundStatus: dto.refundStatus,
          refundNote:
            dto.refundNote != null
              ? dto.refundNote.trim() || null
              : current.refundNote,
          refundedAt:
            dto.refundStatus === ReturnRefundStatus.ISSUED
              ? current.refundedAt ?? new Date()
              : null,
        },
      });
      if (becameIssued) {
        await this.commissions.clawbackForOrderItem({
          orderItemId: current.orderItemId,
          actor: user,
          returnRequestId: current.id,
        });
      }
    }

    const updated = await this.prisma.returnRequest.findUnique({
      where: { id: row.id },
      include: {
        order: { select: { displayId: true, customerName: true } },
        orderItem: {
          select: { productName: true, supplierName: true },
        },
      },
    });

    const statusChanged =
      dto.status != null && dto.status !== row.status;
    const refundChanged =
      dto.refundStatus != null && dto.refundStatus !== row.refundStatus;
    if (statusChanged || refundChanged) {
      await this.notifications.notifyReturnStatusChange({
        customerId: row.customerId,
        returnId: row.id,
        orderDisplayId: updated!.order.displayId,
        productName: updated!.orderItem.productName,
        status: statusChanged ? dto.status : undefined,
        refundStatus: refundChanged ? dto.refundStatus : undefined,
      });
    }

    return {
      ...this.toReturnResponse(updated!),
      customerName: updated!.order.customerName,
    };
  }

  private assertReturnTransition(
    current: ReturnRequestStatus,
    next: ReturnRequestStatus,
  ) {
    if (current === next) return;
    const allowed: Record<ReturnRequestStatus, ReturnRequestStatus[]> = {
      [ReturnRequestStatus.REQUESTED]: [
        ReturnRequestStatus.IN_REVIEW,
        ReturnRequestStatus.APPROVED,
        ReturnRequestStatus.REJECTED,
      ],
      [ReturnRequestStatus.IN_REVIEW]: [
        ReturnRequestStatus.APPROVED,
        ReturnRequestStatus.REJECTED,
      ],
      [ReturnRequestStatus.APPROVED]: [ReturnRequestStatus.CLOSED],
      [ReturnRequestStatus.REJECTED]: [ReturnRequestStatus.CLOSED],
      [ReturnRequestStatus.CLOSED]: [],
    };
    if (!allowed[current].includes(next)) {
      throw new BadRequestException(
        `Cannot move return from ${current} to ${next}`,
      );
    }
  }

  private async listReturnRequests(orderId: string, user: AuthUser) {
    const where =
      user.role === UserRole.CUSTOMER
        ? { orderId, customerId: user.sub }
        : { orderId };
    const rows = await this.prisma.returnRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        order: { select: { displayId: true } },
        orderItem: {
          select: { productName: true, supplierName: true, supplierId: true },
        },
      },
    });
    if (user.role === UserRole.SUPPLIER && user.supplierId) {
      return rows
        .filter((row) => row.orderItem.supplierId === user.supplierId)
        .map((row) => this.toReturnResponse(row));
    }
    return rows.map((row) => this.toReturnResponse(row));
  }

  private async listReturnableItems(order: {
    items: Array<{
      id: string;
      productName: string;
      supplierName: string;
      quantity: number;
      status: OrderStatus;
    }>;
  }) {
    const delivered = order.items.filter(
      (item) => item.status === OrderStatus.DELIVERED,
    );
    if (delivered.length === 0) return [];

    const open = await this.prisma.returnRequest.findMany({
      where: {
        orderItemId: { in: delivered.map((item) => item.id) },
        status: {
          in: [ReturnRequestStatus.REQUESTED, ReturnRequestStatus.IN_REVIEW],
        },
      },
      select: { orderItemId: true },
    });
    const blocked = new Set(open.map((row) => row.orderItemId));
    return delivered
      .filter((item) => !blocked.has(item.id))
      .map((item) => ({
        orderItemId: item.id,
        productName: item.productName,
        supplierName: item.supplierName,
        quantity: item.quantity,
      }));
  }

  private toReturnResponse(row: {
    id: string;
    orderId: string;
    orderItemId: string;
    reason: string;
    notes: string | null;
    quantity: number;
    status: string;
    refundStatus?: string;
    refundNote?: string | null;
    refundedAt?: Date | null;
    createdAt: Date;
    order?: { displayId: string };
    orderItem: { productName: string; supplierName: string };
  }) {
    return {
      id: row.id,
      orderId: row.order?.displayId ?? row.orderId,
      orderItemId: row.orderItemId,
      productName: row.orderItem.productName,
      supplierName: row.orderItem.supplierName,
      reason: row.reason,
      notes: row.notes,
      quantity: row.quantity,
      status: row.status,
      refundStatus: row.refundStatus ?? ReturnRefundStatus.NONE,
      refundNote: row.refundNote ?? null,
      refundedAt: row.refundedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async listRateableSuppliers(
    order: {
      id: string;
      items: Array<{
        supplierId: string;
        supplierName: string;
        status: OrderStatus;
      }>;
    },
    customerId: string,
  ) {
    const deliveredBySupplier = new Map<string, string>();
    for (const item of order.items) {
      if (item.status === OrderStatus.DELIVERED) {
        deliveredBySupplier.set(item.supplierId, item.supplierName);
      }
    }
    if (deliveredBySupplier.size === 0) return [];

    const existing = await this.prisma.supplierReview.findMany({
      where: {
        orderId: order.id,
        customerId,
        supplierId: { in: [...deliveredBySupplier.keys()] },
      },
      select: { supplierId: true },
    });
    const alreadyRated = new Set(existing.map((row) => row.supplierId));
    return [...deliveredBySupplier.entries()]
      .filter(([supplierId]) => !alreadyRated.has(supplierId))
      .map(([supplierId, supplierName]) => ({ supplierId, supplierName }));
  }

  /**
   * Customer cancel before any line has shipped/delivered.
   * Restores inventory and marks payment REFUNDED when already PAID.
   */
  async cancel(id: string, user: AuthUser) {
    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can cancel their orders');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        OR: [{ id }, { displayId: id }],
        customerId: user.sub,
      },
      include: orderWithItems,
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.status === OrderStatus.CANCELLED) {
      return this.toResponse(order, 'Order already cancelled');
    }

    const blocked = order.items.some(
      (item) =>
        item.status === OrderStatus.SHIPPED ||
        item.status === OrderStatus.DELIVERED,
    );
    if (blocked) {
      throw new BadRequestException(
        'Cannot cancel after a supplier has shipped or delivered an item',
      );
    }

    const unpaidCod =
      order.paymentMode === 'cod' &&
      order.paymentStatus === PaymentStatus.PENDING;

    await this.prisma.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { orderId: order.id },
        data: { status: OrderStatus.CANCELLED },
      });
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.CANCELLED,
          paymentStatus:
            order.paymentStatus === PaymentStatus.PAID
              ? PaymentStatus.REFUNDED
              : unpaidCod
                ? PaymentStatus.FAILED
                : order.paymentStatus,
        },
      });
    });

    await this.restoreStock(order.id, user.sub, 'ORDER_CANCELLED');

    // Unpaid COD cancel: remove pending commissions from settleable/pending rollups.
    if (unpaidCod) {
      for (const item of order.items) {
        await this.commissions.clawbackForOrderItem({
          orderItemId: item.id,
          actor: user,
        });
      }
    }

    const updated = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: orderWithItems,
    });
    return this.toResponse(
      updated!,
      unpaidCod
        ? 'Order cancelled, stock restored, and unpaid COD commission cleared'
        : 'Order cancelled and stock restored',
    );
  }

  async updateItemStatus(
    orderId: string,
    itemId: string,
    dto: UpdateItemStatusDto,
    user: AuthUser,
  ) {
    if (user.role !== UserRole.SUPPLIER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only suppliers or admins can update items');
    }

    const item = await this.prisma.orderItem.findUnique({
      where: { id: itemId },
      include: { order: true },
    });
    if (!item || (item.orderId !== orderId && item.order.displayId !== orderId)) {
      throw new NotFoundException('Order item not found');
    }
    if (
      user.role === UserRole.SUPPLIER &&
      item.supplierId !== user.supplierId
    ) {
      throw new ForbiddenException('Cannot update another supplier item');
    }

    if (
      item.status === OrderStatus.RETURNED ||
      item.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        `Cannot fulfill a ${item.status.toLowerCase()} order line`,
      );
    }

    const nextItemStatus = dto.status ?? item.status;
    if (
      nextItemStatus === OrderStatus.RETURNED ||
      nextItemStatus === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException(
        'Use the returns workflow to mark items as returned',
      );
    }

    await this.prisma.orderItem.update({
      where: { id: item.id },
      data: {
        status: nextItemStatus,
        trackingCode: dto.trackingCode,
        pickupCode: dto.pickupCode,
      },
    });

    const items = await this.prisma.orderItem.findMany({
      where: { orderId: item.orderId },
    });
    const rollup = rollupStatus(items.map((row) => row.status));
    const isCodPending =
      item.order.paymentMode === 'cod' &&
      item.order.paymentStatus === PaymentStatus.PENDING;
    // COD: only mark PAID when the whole order is delivered, or explicit collect.
    // Partial multi-supplier delivery must not flip payment for undelivered lines.
    const markCodPaid =
      isCodPending &&
      (Boolean(dto.collectPayment) || rollup === OrderStatus.DELIVERED);

    const order = await this.prisma.order.update({
      where: { id: item.orderId },
      data: {
        status: rollup,
        ...(markCodPaid ? { paymentStatus: PaymentStatus.PAID } : {}),
      },
      include: {
        items: {
          ...(user.role === UserRole.SUPPLIER && user.supplierId
            ? { where: { supplierId: user.supplierId } }
            : {}),
          include: { commission: true },
        },
      },
    });

    if (
      user.role === UserRole.SUPPLIER &&
      (nextItemStatus === OrderStatus.SHIPPED ||
        nextItemStatus === OrderStatus.DELIVERED)
    ) {
      await this.onboarding.onSupplierShipped(user.sub);
    }

    // Advance recognition for the touched line; if COD just paid, advance all lines.
    if (markCodPaid) {
      const allItems = await this.prisma.orderItem.findMany({
        where: { orderId: item.orderId },
        select: { id: true },
      });
      for (const row of allItems) {
        await this.commissions.advanceRecognitionForItem(row.id);
      }
    } else {
      await this.commissions.advanceRecognitionForItem(item.id);
    }

    return this.toResponse(order);
  }

  private async restoreStock(
    orderId: string,
    userId: string,
    reason = 'ORDER_PAYMENT_FAILED',
  ) {
    const items = await this.prisma.orderItem.findMany({ where: { orderId } });
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });
        if (!product) continue;
        const next = product.stock + item.quantity;
        await tx.product.update({
          where: { id: product.id },
          data: { stock: next, stockStatus: stockStatusFor(next) },
        });
        await tx.inventoryLedger.create({
          data: {
            productId: product.id,
            supplierId: product.supplierId,
            delta: item.quantity,
            reason,
            eventId: `order-restore-${reason}-${orderId}-${product.id}-${Date.now()}`,
            userId,
            quantityAfter: next,
          },
        });
      }
    });
  }

  private assertCanView(
    order: { customerId: string; items: { supplierId: string }[] },
    user: AuthUser,
  ) {
    if (user.role === UserRole.ADMIN) return;
    if (user.role === UserRole.CUSTOMER && order.customerId === user.sub) {
      return;
    }
    if (
      user.role === UserRole.SUPPLIER &&
      user.supplierId &&
      order.items.some((item) => item.supplierId === user.supplierId)
    ) {
      return;
    }
    throw new ForbiddenException('Cannot view this order');
  }

  private toResponse(
    order: {
      id: string;
      displayId: string;
      customerId: string;
      customerName: string;
      customerEmail: string;
      status: OrderStatus;
      paymentStatus: PaymentStatus;
      paymentMethod: string;
      paymentMode: string;
      stripePaymentIntentId: string | null;
      currency: string;
      subtotal: Prisma.Decimal;
      taxAmount?: Prisma.Decimal;
      deliveryFee?: Prisma.Decimal;
      total: Prisma.Decimal;
      addressLine: string | null;
      city: string | null;
      createdAt: Date;
      items: Array<{
        id: string;
        productId: string;
        productName: string;
        supplierId: string;
        supplierName: string;
        unitPrice: Prisma.Decimal;
        quantity: number;
        lineTotal: Prisma.Decimal;
        status: OrderStatus;
        trackingCode: string | null;
        pickupCode: string | null;
        replacesOrderItemId?: string | null;
        replacesOrderItem?: {
          id: string;
          order: { displayId: string };
        } | null;
        replacedBy?: {
          id: string;
          order: { displayId: string };
        } | null;
        commission?: {
          ratePercent: Prisma.Decimal;
          commissionBase: Prisma.Decimal;
          commissionAmount: Prisma.Decimal;
          status: CommissionRecognitionStatus;
          isDemo: boolean;
        } | null;
      }>;
    },
    paymentMessage?: string,
  ) {
    return {
      id: order.id,
      displayId: order.displayId,
      customerId: order.customerId,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      paymentMode: order.paymentMode,
      stripePaymentIntentId: order.stripePaymentIntentId,
      currency: order.currency,
      settlementCurrency:
        'settlementCurrency' in order
          ? (order as { settlementCurrency?: string }).settlementCurrency ??
            order.currency
          : order.currency,
      displayCurrency:
        'displayCurrency' in order
          ? (order as { displayCurrency?: string | null }).displayCurrency ?? null
          : null,
      displayTotal:
        'displayTotal' in order &&
        (order as { displayTotal?: { toNumber?: () => number } | null }).displayTotal !=
          null
          ? Number(
              (order as { displayTotal?: { toString(): string } | null }).displayTotal,
            )
          : null,
      paymentCurrency:
        'paymentCurrency' in order
          ? (order as { paymentCurrency?: string }).paymentCurrency ?? order.currency
          : order.currency,
      paymentAmount:
        'paymentAmount' in order &&
        (order as { paymentAmount?: unknown }).paymentAmount != null
          ? Number((order as { paymentAmount?: { toString(): string } }).paymentAmount)
          : Number(order.total),
      fxRate:
        'fxRate' in order && (order as { fxRate?: unknown }).fxRate != null
          ? Number((order as { fxRate?: { toString(): string } }).fxRate)
          : null,
      subtotal: Number(order.subtotal),
      tax: Number(order.taxAmount ?? 0),
      deliveryFee: Number(order.deliveryFee ?? 0),
      total: Number(order.total),
      addressLine: order.addressLine,
      city: order.city,
      createdAt: order.createdAt.toISOString(),
      paymentMessage,
      items: order.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        supplierId: item.supplierId,
        supplierName: item.supplierName,
        unitPrice: Number(item.unitPrice),
        quantity: item.quantity,
        lineTotal: Number(item.lineTotal),
        status: item.status,
        trackingCode: item.trackingCode,
        pickupCode: item.pickupCode,
        replacesOrderItemId: item.replacesOrderItemId ?? null,
        replacesOrderId: item.replacesOrderItem?.order.displayId ?? null,
        replacedByOrderId: item.replacedBy?.order.displayId ?? null,
        commission: item.commission
          ? {
              ratePercent: Number(item.commission.ratePercent),
              commissionBase: Number(item.commission.commissionBase),
              commissionAmount: Number(item.commission.commissionAmount),
              status: item.commission.status,
              isDemo: item.commission.isDemo,
            }
          : null,
      })),
    };
  }
}

function isPayOnDelivery(method?: string): boolean {
  if (!method) return false;
  const normalized = method.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (
    normalized === 'pay_on_delivery' ||
    normalized === 'cod' ||
    normalized === 'cash_on_delivery'
  );
}

/** Simple marketplace fulfillment quotes — additive, no commission impact. */
function computeFulfillmentFees(input: {
  subtotal: number;
  deliveryMethod?: string;
  city?: string;
  supplierNames: string[];
}) {
  const method = normalizeDeliveryMethod(input.deliveryMethod);
  const city = (input.city ?? 'Nairobi').trim() || 'Nairobi';
  const suppliers =
    input.supplierNames.length > 0 ? input.supplierNames : ['Supplier'];
  const perShipment =
    method === 'pickup' ? 0 : method === 'express' ? 9.99 : 4.99;
  const shipments = suppliers.map((supplierName) => ({
    supplierName,
    deliveryMethod: method,
    fee: perShipment,
    estimate: estimateLabel(method, city),
  }));
  const deliveryFee = roundMoney(
    shipments.reduce((sum, shipment) => sum + shipment.fee, 0),
  );
  const tax = roundMoney(input.subtotal * 0.08);
  const subtotal = roundMoney(input.subtotal);
  return {
    subtotal,
    deliveryFee,
    tax,
    total: roundMoney(subtotal + deliveryFee + tax),
    deliveryMethod: method,
    shipments,
  };
}

function normalizeDeliveryMethod(method?: string): 'express' | 'standard' | 'pickup' {
  const normalized = (method ?? 'standard').trim().toLowerCase();
  if (normalized === 'express' || normalized === 'pickup') return normalized;
  return 'standard';
}

function estimateLabel(
  method: 'express' | 'standard' | 'pickup',
  city: string,
): string {
  switch (method) {
    case 'express':
      return `1–2 days to ${city}`;
    case 'pickup':
      return `Ready for pickup in ${city}`;
    default:
      return `3–5 days to ${city}`;
  }
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function stockStatusFor(quantity: number): StockStatus {
  if (quantity <= 0) return StockStatus.OUT_OF_STOCK;
  if (quantity <= 5) return StockStatus.LOW_STOCK;
  return StockStatus.IN_STOCK;
}

function rollupStatus(statuses: OrderStatus[]): OrderStatus {
  if (statuses.length === 0) return OrderStatus.PROCESSING;
  if (statuses.every((s) => s === OrderStatus.RETURNED)) {
    return OrderStatus.RETURNED;
  }
  if (statuses.every((s) => s === OrderStatus.DELIVERED)) {
    return OrderStatus.DELIVERED;
  }
  if (statuses.every((s) => s === OrderStatus.CANCELLED)) {
    return OrderStatus.CANCELLED;
  }
  if (
    statuses.every(
      (s) =>
        s === OrderStatus.SHIPPED ||
        s === OrderStatus.DELIVERED ||
        s === OrderStatus.RETURNED,
    ) &&
    statuses.some((s) => s === OrderStatus.SHIPPED)
  ) {
    return OrderStatus.SHIPPED;
  }
  if (
    statuses.some(
      (s) =>
        s === OrderStatus.SHIPPED ||
        s === OrderStatus.DELIVERED ||
        s === OrderStatus.RETURNED,
    )
  ) {
    return OrderStatus.PARTIAL;
  }
  if (statuses.every((s) => s === OrderStatus.READY_FOR_PICKUP)) {
    return OrderStatus.READY_FOR_PICKUP;
  }
  if (statuses.some((s) => s === OrderStatus.READY_FOR_PICKUP)) {
    return OrderStatus.READY_FOR_PICKUP;
  }
  return OrderStatus.PROCESSING;
}
