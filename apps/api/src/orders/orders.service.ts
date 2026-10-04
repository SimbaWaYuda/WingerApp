import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
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
};

export type ValidateCartDto = {
  items: CreateOrderItemDto[];
};

export type UpdateItemStatusDto = {
  status?: OrderStatus;
  trackingCode?: string;
  pickupCode?: string;
  /** Collect COD payment (marks order PAID). */
  collectPayment?: boolean;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly onboarding: OnboardingService,
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

    return {
      ok,
      currency: 'usd',
      subtotal,
      total: subtotal,
      deliveryFee: 0,
      tax: 0,
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
    const total = subtotal;
    const payOnDelivery = isPayOnDelivery(dto.paymentMethod);

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
          currency: 'usd',
          subtotal,
          total,
          addressLine: dto.addressLine ?? 'Westlands',
          city: dto.city ?? 'Nairobi',
          items: {
            create: lines.map((line) => ({
              productId: line.product.id,
              productName: line.product.name,
              supplierId: line.product.supplierId,
              supplierName: line.product.supplierName,
              unitPrice: line.unitPrice,
              quantity: line.quantity,
              lineTotal: line.lineTotal,
              status: OrderStatus.PROCESSING,
            })),
          },
        },
        include: { items: true },
      });

      for (const line of lines) {
        const next = line.product.stock - line.quantity;
        await tx.product.update({
          where: { id: line.product.id },
          data: {
            stock: next,
            stockStatus: stockStatusFor(next),
          },
        });
        await tx.inventoryLedger.create({
          data: {
            productId: line.product.id,
            supplierId: line.product.supplierId,
            delta: -line.quantity,
            reason: 'ORDER_SALE',
            eventId: `order-${created.id}-${line.product.id}`,
            userId: user.sub,
            quantityAfter: next,
          },
        });
      }

      return created;
    });

    if (payOnDelivery) {
      await this.onboarding.onOrderPlaced(user.sub, user.role);
      return this.toResponse(
        order,
        'Pay on delivery — collect payment when the order is delivered',
      );
    }

    const amountCents = Math.round(Number(total) * 100);
    const charge = await this.stripe.chargeOrder({
      amountCents,
      currency: 'usd',
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
      include: { items: true },
    });

    if (paymentStatus === PaymentStatus.FAILED) {
      await this.restoreStock(updated.id, user.sub);
      throw new BadRequestException(charge.message);
    }

    await this.onboarding.onOrderPlaced(user.sub, user.role);
    return this.toResponse(updated, charge.message);
  }

  async list(user: AuthUser) {
    if (user.role === UserRole.CUSTOMER) {
      const orders = await this.prisma.order.findMany({
        where: { customerId: user.sub },
        include: { items: true },
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
      include: { items: true },
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
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    this.assertCanView(order, user);
    return this.toResponse(order);
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

    const nextItemStatus = dto.status ?? item.status;
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
    // COD becomes PAID when delivered or when supplier collects payment.
    const markCodPaid =
      isCodPending &&
      (Boolean(dto.collectPayment) ||
        nextItemStatus === OrderStatus.DELIVERED ||
        rollup === OrderStatus.DELIVERED);

    const order = await this.prisma.order.update({
      where: { id: item.orderId },
      data: {
        status: rollup,
        ...(markCodPaid ? { paymentStatus: PaymentStatus.PAID } : {}),
      },
      include: {
        items:
          user.role === UserRole.SUPPLIER && user.supplierId
            ? { where: { supplierId: user.supplierId } }
            : true,
      },
    });

    if (
      user.role === UserRole.SUPPLIER &&
      (nextItemStatus === OrderStatus.SHIPPED ||
        nextItemStatus === OrderStatus.DELIVERED)
    ) {
      await this.onboarding.onSupplierShipped(user.sub);
    }

    return this.toResponse(order);
  }

  private async restoreStock(orderId: string, userId: string) {
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
            reason: 'ORDER_PAYMENT_FAILED',
            eventId: `order-restore-${orderId}-${product.id}-${Date.now()}`,
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
      subtotal: Number(order.subtotal),
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

function stockStatusFor(quantity: number): StockStatus {
  if (quantity <= 0) return StockStatus.OUT_OF_STOCK;
  if (quantity <= 5) return StockStatus.LOW_STOCK;
  return StockStatus.IN_STOCK;
}

function rollupStatus(statuses: OrderStatus[]): OrderStatus {
  if (statuses.length === 0) return OrderStatus.PROCESSING;
  if (statuses.every((s) => s === OrderStatus.DELIVERED)) {
    return OrderStatus.DELIVERED;
  }
  if (statuses.every((s) => s === OrderStatus.CANCELLED)) {
    return OrderStatus.CANCELLED;
  }
  if (statuses.every((s) => s === OrderStatus.SHIPPED || s === OrderStatus.DELIVERED)) {
    return OrderStatus.SHIPPED;
  }
  if (statuses.some((s) => s === OrderStatus.SHIPPED || s === OrderStatus.DELIVERED)) {
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
