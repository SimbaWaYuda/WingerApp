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
import { AuditService } from '../commissions/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { commissionReportRow, sumCommissionBuckets } from '../commissions/commission.math';
import { FxService } from '../fx/fx.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeFulfillmentFees, normalizeDeliveryMethod } from './delivery-fees';
import { PayoutsService } from './payouts.service';
import { cardRefundAmount, ChargeResult, PaymentIntentEvent, StripeService } from './stripe.service';

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
  /** Stripe PaymentMethod id from the customer’s card. Never a card number. */
  stripePaymentMethodId?: string;
  /** Stable id for one pay tap. A retry with the same id does not create another order. */
  checkoutIdempotencyKey?: string;
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
          order: { select: { displayId: true, paymentMode: true } },
        },
      },
      replacedBy: {
        select: {
          id: true,
          order: { select: { displayId: true, paymentMode: true } },
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
    private readonly audit: AuditService,
    private readonly payouts: PayoutsService,
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

    const fees = await this.quoteFulfillment({
      subtotal,
      deliveryMethod: dto.deliveryMethod,
      city: dto.city,
      lines: lines.flatMap((line) =>
        line.product
          ? [
              {
                supplierId: line.product.supplierId,
                supplierName: line.product.supplierName,
                lineTotal: line.lineTotal,
              },
            ]
          : [],
      ),
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
    const checkoutKey = this.checkoutKey(dto);
    const resumed = await this.resumeCheckout(checkoutKey, dto, user);
    if (resumed) return resumed;
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
    const fees = await this.quoteFulfillment({
      subtotal: Number(subtotal),
      deliveryMethod: dto.deliveryMethod,
      city: dto.city,
      lines: lines.map((line) => ({
        supplierId: line.product.supplierId,
        supplierName: line.product.supplierName,
        lineTotal: Number(line.lineTotal),
      })),
    });
    const total = new Prisma.Decimal(fees.total.toFixed(2));
    const payOnDelivery = isPayOnDelivery(dto.paymentMethod);
    const stripePaymentMethodId = this.requireCardPaymentMethod(dto, payOnDelivery);
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

    let order;
    try {
      order = await this.prisma.$transaction(async (tx) => {
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
          paymentMode: payOnDelivery ? 'cod' : this.stripe.checkoutMode,
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
          checkoutIdempotencyKey: checkoutKey,
          items: {
            create: lines.map((line) => {
              const shipment = fees.shipments.find(
                (row) => row.supplierId === line.product.supplierId,
              );
              return {
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
              carrier: shipment?.carrier ?? null,
              courierName: shipment?.courierName ?? null,
              };
            }),
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
    } catch (error) {
      if (checkoutKey && isUniqueConflict(error)) {
        const raced = await this.resumeCheckout(checkoutKey, dto, user);
        if (raced) return raced;
      }
      throw error;
    }

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

    return this.chargeAndRecord(order, stripePaymentMethodId, user);
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
          },
          select: {
            commissionAmount: true,
            status: true,
            isDemo: true,
            orderItem: {
              select: {
                status: true,
                supplierId: true,
                order: {
                  select: {
                    paymentStatus: true,
                    paymentMode: true,
                    cashCollections: { select: { supplierId: true } },
                  },
                },
              },
            },
          },
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

    const buckets = sumCommissionBuckets(
      commissions.map((row) => commissionReportRow(row)),
    );

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      currency: 'USD',
      gmv: round(Number(gmv._sum.subtotal ?? 0)),
      wingerRevenue: buckets.earnedRevenue,
      pendingCommission: buckets.pendingCommission,
      recognizedCommission: buckets.recognizedCommission,
      settleableCommission: buckets.settleableCommission,
      reversedCommission: buckets.reversedCommission,
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
        carrier: true,
        courierName: true,
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
      carrier: string | null;
      courierName: string | null;
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
          carrier: item.carrier,
          courierName: item.courierName,
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
        order: { select: { displayId: true, paymentMode: true } },
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
        order: { select: { displayId: true, customerName: true, paymentMode: true } },
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
              carrier: source.carrier,
              courierName: source.courierName,
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
      if (becameIssued) {
        await this.refundCardForReturn(row, current.quantity);
      }
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
        await this.payouts.reverseIfTransferred(current.orderItemId);
      }
    }

    const updated = await this.prisma.returnRequest.findUnique({
      where: { id: row.id },
      include: {
        order: { select: { displayId: true, customerName: true, paymentMode: true } },
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

  /**
   * Card charges are refunded in Stripe before the return is marked issued.
   * Cash on delivery and demo orders never touched Stripe, so they stay ledger-only.
   */
  private async refundCardForReturn(
    row: {
      id: string;
      orderId: string;
      order: {
        paymentMode: string;
        stripePaymentIntentId: string | null;
        paymentAmount: Prisma.Decimal | null;
        subtotal: Prisma.Decimal;
        total: Prisma.Decimal;
      };
      orderItem: { unitPrice: Prisma.Decimal };
    },
    quantity: number,
  ) {
    const mode = row.order.paymentMode;
    if (mode !== 'test' && mode !== 'live') return;
    const paymentIntentId = row.order.stripePaymentIntentId;
    if (!paymentIntentId) {
      throw new BadRequestException('This card payment has no Stripe charge to refund');
    }
    const amount = cardRefundAmount({
      paymentAmount: Number(row.order.paymentAmount ?? row.order.total),
      subtotal: Number(row.order.subtotal),
      unitPrice: Number(row.orderItem.unitPrice),
      quantity,
    });
    const result = await this.stripe.refundCardCharge({
      paymentIntentId,
      amount,
      idempotencyKey: `winger-refund-${row.id}`,
      orderId: row.orderId,
      returnRequestId: row.id,
    });
    if (!result.ok) {
      throw new BadRequestException(result.message);
    }
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
        order: { select: { displayId: true, paymentMode: true } },
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
    order?: { displayId: string; paymentMode?: string };
    orderItem: { productName: string; supplierName: string };
  }) {
    return {
      id: row.id,
      orderId: row.order?.displayId ?? row.orderId,
      paymentMode: row.order?.paymentMode ?? null,
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
        await this.payouts.reverseIfTransferred(item.id);
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
    await this.prisma.order.update({
      where: { id: item.orderId },
      data: { status: rollup },
    });

    if (
      user.role === UserRole.SUPPLIER &&
      (nextItemStatus === OrderStatus.SHIPPED ||
        nextItemStatus === OrderStatus.DELIVERED)
    ) {
      await this.onboarding.onSupplierShipped(user.sub);
    }

    if (dto.collectPayment) {
      await this.collectSupplierCash(item.orderId, item.supplierId, user);
    } else {
      await this.recognizeAndTransfer(item.id);
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: item.orderId },
      include: {
        items: {
          ...(user.role === UserRole.SUPPLIER && user.supplierId
            ? { where: { supplierId: user.supplierId } }
            : {}),
          include: { commission: true },
        },
      },
    });

    return this.toResponse(order);
  }

  /**
   * Records cash for this supplier's lines only. The order stays unpaid until
   * every supplier on it has a collection. Commission becomes settleable only
   * after those lines are delivered as well.
   */
  private async collectSupplierCash(
    orderId: string,
    supplierId: string,
    user: AuthUser,
  ) {
    if (user.role === UserRole.SUPPLIER && user.supplierId !== supplierId) {
      throw new ForbiddenException('Cannot collect payment for another supplier');
    }
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.paymentMode !== 'cod') {
      throw new BadRequestException('Cash collection is only for pay on delivery');
    }
    if (
      order.paymentStatus === PaymentStatus.FAILED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException('This order cannot accept a cash collection');
    }

    const supplierItems = order.items.filter((row) => row.supplierId === supplierId);
    if (supplierItems.length === 0) {
      throw new BadRequestException('This supplier has no lines on the order');
    }

    const existingCollections = await this.prisma.cashCollection.findMany({
      where: { orderId },
    });
    if (order.paymentStatus === PaymentStatus.PAID && existingCollections.length === 0) {
      for (const row of supplierItems) {
        await this.recognizeAndTransfer(row.id);
      }
      return;
    }

    const already = existingCollections.find((row) => row.supplierId === supplierId);
    if (!already) {
      const orderBase = order.items.reduce(
        (sum, row) => sum + Number(row.lineTotal),
        0,
      );
      const supplierBase = supplierItems.reduce(
        (sum, row) => sum + Number(row.lineTotal),
        0,
      );
      const payment = Number(order.paymentAmount ?? order.total);
      const share = orderBase === 0 ? 0 : supplierBase / orderBase;
      const amount = roundMoney(payment * share);
      const currency = order.paymentCurrency || order.currency || 'USD';
      const lineIds = supplierItems.map((row) => row.id);
      try {
        await this.prisma.cashCollection.create({
          data: {
            orderId,
            supplierId,
            collectedByUserId: user.sub,
            amount: new Prisma.Decimal(amount.toFixed(2)),
            currency,
            lineIds,
          },
        });
        await this.audit.record({
          entityType: 'CashCollection',
          entityId: orderId,
          action: 'COD_CASH_COLLECTED',
          actorUserId: user.sub,
          actorRole: user.role,
          after: {
            orderId,
            supplierId,
            amount,
            currency,
            lineIds,
            collectedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        if (!isUniqueConflict(error)) throw error;
      }
    }

    const collections = await this.prisma.cashCollection.findMany({
      where: { orderId },
    });
    const supplierIds = new Set(order.items.map((row) => row.supplierId));
    const collectedIds = new Set(collections.map((row) => row.supplierId));
    const allCollected = [...supplierIds].every((id) => collectedIds.has(id));
    if (allCollected) {
      await this.prisma.order.updateMany({
        where: { id: orderId, paymentStatus: PaymentStatus.PENDING },
        data: { paymentStatus: PaymentStatus.PAID },
      });
    }

    for (const row of supplierItems) {
      await this.recognizeAndTransfer(row.id);
    }
  }

  private async recognizeAndTransfer(orderItemId: string) {
    const snap = await this.commissions.advanceRecognitionForItem(orderItemId);
    if (snap?.status === CommissionRecognitionStatus.SETTLEABLE) {
      await this.payouts.transferIfSettleable(orderItemId);
    }
  }

  /** Saves a card result once. A second success for the same PaymentIntent is a no-op. */
  async recordCardCharge(orderId: string, charge: ChargeResult, user: AuthUser) {
    const current = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderWithItems,
    });
    if (!current) throw new NotFoundException('Order not found');

    if (charge.status !== 'paid') {
      if (current.paymentStatus === PaymentStatus.PAID) {
        return this.toResponse(current, charge.message);
      }
      if (current.paymentStatus === PaymentStatus.FAILED) {
        throw new BadRequestException(charge.message);
      }
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          paymentStatus: PaymentStatus.FAILED,
          paymentMode: charge.mode,
          stripePaymentIntentId: charge.paymentIntentId,
          status: OrderStatus.CANCELLED,
        },
      });
      await this.restoreStock(orderId, user.sub);
      throw new BadRequestException(charge.message);
    }

    if (
      current.paymentStatus === PaymentStatus.PAID &&
      current.stripePaymentIntentId &&
      charge.paymentIntentId &&
      current.stripePaymentIntentId !== charge.paymentIntentId
    ) {
      return this.toResponse(current, charge.message);
    }

    if (
      current.paymentStatus === PaymentStatus.PAID &&
      (!charge.paymentIntentId ||
        !current.stripePaymentIntentId ||
        current.stripePaymentIntentId === charge.paymentIntentId)
    ) {
      await this.commissions.createSnapshotsForOrder({
        orderId,
        paymentMode: charge.mode,
        isDemo: charge.mode !== 'live',
        initialStatus: CommissionRecognitionStatus.RECOGNIZED,
      });
      return this.toResponse(current, charge.message);
    }

    const claimed = await this.claimPaidOrder(orderId, charge, current.status);
    await this.commissions.createSnapshotsForOrder({
      orderId,
      paymentMode: charge.mode,
      isDemo: charge.mode !== 'live',
      initialStatus: CommissionRecognitionStatus.RECOGNIZED,
    });
    if (claimed.count > 0) {
      await this.onboarding.onOrderPlaced(user.sub, user.role);
    }
    const saved = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: orderWithItems,
    });
    return this.toResponse(saved, charge.message);
  }

  private async claimPaidOrder(
    orderId: string,
    charge: ChargeResult,
    currentStatus: OrderStatus,
  ) {
    const data = {
      paymentStatus: PaymentStatus.PAID,
      paymentMode: charge.mode,
      stripePaymentIntentId: charge.paymentIntentId,
      ...(currentStatus === OrderStatus.CANCELLED ||
      currentStatus === OrderStatus.PROCESSING
        ? { status: OrderStatus.PROCESSING }
        : {}),
    };
    const write = () =>
      this.prisma.order.updateMany({
        where: {
          id: orderId,
          paymentStatus: { not: PaymentStatus.PAID },
        },
        data,
      });
    try {
      return await write();
    } catch (firstError) {
      if (!charge.paymentIntentId) throw firstError;
      try {
        return await write();
      } catch {
        throw firstError;
      }
    }
  }

  private checkoutKey(dto: CreateOrderDto): string | null {
    const key = dto.checkoutIdempotencyKey?.trim() ?? '';
    if (!key) return null;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
      throw new BadRequestException('Invalid checkout id');
    }
    return key;
  }

  private async resumeCheckout(
    checkoutKey: string | null,
    dto: CreateOrderDto,
    user: AuthUser,
  ) {
    if (!checkoutKey) return null;
    const existing = await this.prisma.order.findUnique({
      where: { checkoutIdempotencyKey: checkoutKey },
      include: orderWithItems,
    });
    if (!existing) return null;
    if (existing.customerId !== user.sub) {
      throw new ForbiddenException('Checkout does not belong to this customer');
    }
    if (
      existing.paymentStatus === PaymentStatus.PAID ||
      existing.paymentMode === 'cod'
    ) {
      return this.toResponse(existing);
    }
    if (existing.paymentStatus === PaymentStatus.PENDING) {
      const method = this.requireCardPaymentMethod(dto, false);
      return this.chargeAndRecord(existing, method, user);
    }
    throw new BadRequestException(
      'This checkout already failed. Start a new payment.',
    );
  }

  private async chargeAndRecord(
    order: {
      id: string;
      displayId: string;
      customerEmail: string;
      paymentAmount?: { toString(): string } | null;
      total: { toString(): string };
      paymentCurrency?: string | null;
      currency: string;
    },
    paymentMethodId: string | undefined,
    user: AuthUser,
  ) {
    const paymentAmount = Number(order.paymentAmount ?? order.total);
    const paymentCurrency = order.paymentCurrency || order.currency || 'USD';
    const charge = await this.stripe.chargeOrder({
      amountCents: Math.round(paymentAmount * 100),
      currency: paymentCurrency.toLowerCase(),
      orderId: order.id,
      orderDisplayId: order.displayId,
      customerEmail: order.customerEmail || user.email,
      paymentMethodId,
      idempotencyKey: `winger-charge-${order.id}`,
    });
    return this.recordCardCharge(order.id, charge, user);
  }

  private async findOrderForIntent(intent: {
    id: string;
    metadata?: Record<string, string> | null;
  }) {
    const orderId = intent.metadata?.orderId;
    if (orderId) {
      const byId = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (byId) return byId;
    }
    if (!intent.id) return null;
    return this.prisma.order.findUnique({
      where: { stripePaymentIntentId: intent.id },
    });
  }

  private async reReserveStock(orderId: string, userId: string) {
    const items = await this.prisma.orderItem.findMany({ where: { orderId } });
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const eventId = `order-rereserve-${orderId}-${item.productId}`;
        const already = await tx.inventoryLedger.findUnique({ where: { eventId } });
        if (already) continue;
        const product = await tx.product.findUnique({
          where: { id: item.productId },
        });
        if (!product) continue;
        const next = product.stock - item.quantity;
        await tx.product.update({
          where: { id: product.id },
          data: { stock: next, stockStatus: stockStatusFor(next) },
        });
        await tx.inventoryLedger.create({
          data: {
            productId: product.id,
            supplierId: product.supplierId,
            delta: -item.quantity,
            reason: 'ORDER_PAYMENT_RERESERVE',
            eventId,
            userId,
            quantityAfter: next,
          },
        });
      }
    });
  }

  async handleStripeEvent(event: PaymentIntentEvent) {
    if (
      event.type !== 'payment_intent.succeeded' &&
      event.type !== 'payment_intent.payment_failed'
    ) {
      return { received: true };
    }
    const intent = event.data.object;
    const order = await this.findOrderForIntent(intent);
    if (!order) return { received: true, matched: false };

    const mode: 'test' | 'live' = event.livemode ? 'live' : 'test';
    const actor = {
      sub: order.customerId,
      email: order.customerEmail,
      name: order.customerName,
      role: UserRole.CUSTOMER,
    };

    if (event.type === 'payment_intent.payment_failed') {
      if (order.paymentStatus === PaymentStatus.PAID) {
        return { received: true, ignored: true };
      }
      if (order.paymentStatus === PaymentStatus.FAILED) {
        return { received: true, duplicate: true };
      }
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: PaymentStatus.FAILED,
          paymentMode: mode,
          stripePaymentIntentId: intent.id,
          status: OrderStatus.CANCELLED,
        },
      });
      await this.restoreStock(order.id, order.customerId);
      return { received: true };
    }

    if (
      order.paymentStatus === PaymentStatus.PAID &&
      order.stripePaymentIntentId === intent.id
    ) {
      await this.commissions.createSnapshotsForOrder({
        orderId: order.id,
        paymentMode: mode,
        isDemo: !event.livemode,
        initialStatus: CommissionRecognitionStatus.RECOGNIZED,
      });
      return { received: true, duplicate: true };
    }

    if (
      order.paymentStatus === PaymentStatus.FAILED ||
      order.status === OrderStatus.CANCELLED
    ) {
      await this.reReserveStock(order.id, order.customerId);
    }

    await this.recordCardCharge(
      order.id,
      {
        mode,
        status: 'paid',
        paymentIntentId: intent.id,
        message: 'Stripe payment succeeded',
      },
      actor,
    );
    return { received: true };
  }

  /** Test and live card checkout must name a Stripe PaymentMethod. Demo does not. */
  private requireCardPaymentMethod(
    dto: CreateOrderDto,
    payOnDelivery: boolean,
  ): string | undefined {
    if (payOnDelivery || this.stripe.checkoutMode === 'demo') return undefined;
    const id = dto.stripePaymentMethodId?.trim() ?? '';
    if (!/^pm_[A-Za-z0-9_]+$/.test(id)) {
      throw new BadRequestException('Enter a card to pay');
    }
    return id;
  }

  private async restoreStock(
    orderId: string,
    userId: string,
    reason = 'ORDER_PAYMENT_FAILED',
  ) {
    const items = await this.prisma.orderItem.findMany({ where: { orderId } });
    await this.prisma.$transaction(async (tx) => {
      for (const item of items) {
        const eventId = `order-restore-${reason}-${orderId}-${item.productId}`;
        const already = await tx.inventoryLedger.findUnique({ where: { eventId } });
        if (already) continue;
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
            eventId,
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
        carrier?: string | null;
        courierName?: string | null;
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
        carrier: item.carrier ?? null,
        courierName: item.courierName ?? null,
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

  private async quoteFulfillment(input: {
    subtotal: number;
    deliveryMethod?: string;
    city?: string;
    lines: { supplierId: string; supplierName: string; lineTotal: number }[];
  }) {
    const grouped = new Map<string, { supplierName: string; merchandise: number }>();
    for (const line of input.lines) {
      const current = grouped.get(line.supplierId);
      if (current) current.merchandise += line.lineTotal;
      else {
        grouped.set(line.supplierId, {
          supplierName: line.supplierName,
          merchandise: line.lineTotal,
        });
      }
    }
    const ids = [...grouped.keys()];
    const rows = ids.length
      ? await this.prisma.supplier.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            standardDeliveryFee: true,
            expressDeliveryFee: true,
            pickupDeliveryFee: true,
            freeDeliveryThreshold: true,
            taxRatePercent: true,
            taxOnDelivery: true,
            carrier: true,
            courierName: true,
          },
        })
      : [];
    const rates = new Map(rows.map((row) => [row.id, row]));
    return computeFulfillmentFees({
      subtotal: input.subtotal,
      deliveryMethod: input.deliveryMethod,
      city: input.city,
      suppliers: [...grouped.entries()].map(([supplierId, group]) => {
        const row = rates.get(supplierId);
        return {
          supplierId,
          supplierName: group.supplierName,
          merchandiseSubtotal: group.merchandise,
          standardDeliveryFee: row ? Number(row.standardDeliveryFee) : 4.99,
          expressDeliveryFee: row ? Number(row.expressDeliveryFee) : 9.99,
          pickupDeliveryFee: row ? Number(row.pickupDeliveryFee) : 0,
          freeDeliveryThreshold:
            row?.freeDeliveryThreshold == null ? null : Number(row.freeDeliveryThreshold),
          taxRatePercent: row ? Number(row.taxRatePercent) : 8,
          taxOnDelivery: row?.taxOnDelivery ?? false,
          carrier: row?.carrier === 'courier' ? 'courier' as const : 'supplier' as const,
          courierName: row?.courierName ?? null,
        };
      }),
    });
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

function isUniqueConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
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
