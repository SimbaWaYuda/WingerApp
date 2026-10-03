import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, StockStatus, SyncEventStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export type SyncEventDto = {
  eventId: string;
  deviceId: string;
  userId?: string;
  businessId?: string;
  timestamp: string;
  operation: string;
  payload: Record<string, unknown>;
};

@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(event: SyncEventDto, user: AuthUser) {
    const scoped = this.scopeEvent(event, user);

    const existing = await this.prisma.syncEvent.findUnique({
      where: { eventId: scoped.eventId },
    });
    if (existing) {
      return {
        status: 'DUPLICATE' as const,
        message: 'Event already applied',
        eventId: scoped.eventId,
        productStock:
          scoped.operation.startsWith('INVENTORY_') && scoped.payload.productId
            ? await this.currentStock(String(scoped.payload.productId))
            : undefined,
      };
    }

    if (
      scoped.operation === 'INVENTORY_RECEIVE' ||
      scoped.operation === 'INVENTORY_ADJUST'
    ) {
      this.assertCanMutateInventory(user);
      return this.applyInventoryDelta(scoped, user);
    }

    if (scoped.operation.startsWith('CART_') && user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can sync cart events');
    }

    await this.prisma.syncEvent.create({
      data: {
        eventId: scoped.eventId,
        deviceId: scoped.deviceId,
        userId: scoped.userId,
        businessId: scoped.businessId,
        operation: scoped.operation,
        payloadJson: scoped.payload as Prisma.InputJsonValue,
        status: SyncEventStatus.SUCCESS,
        message: 'Acknowledged',
        clientTs: safeDate(scoped.timestamp),
      },
    });

    return {
      status: 'SUCCESS' as const,
      eventId: scoped.eventId,
    };
  }

  private scopeEvent(event: SyncEventDto, user: AuthUser): SyncEventDto {
    const payload = { ...event.payload };
    if (
      (event.operation === 'INVENTORY_RECEIVE' ||
        event.operation === 'INVENTORY_ADJUST') &&
      user.role === UserRole.SUPPLIER
    ) {
      payload.supplierId = user.supplierId;
    }

    return {
      ...event,
      userId: user.sub,
      businessId:
        user.role === UserRole.SUPPLIER
          ? user.supplierId ?? undefined
          : event.businessId,
      payload,
    };
  }

  private assertCanMutateInventory(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only suppliers or admins can sync inventory');
    }
    if (user.role === UserRole.SUPPLIER && !user.supplierId) {
      throw new ForbiddenException('Supplier account is missing supplierId');
    }
  }

  private async applyInventoryDelta(event: SyncEventDto, user: AuthUser) {
    const productId = String(event.payload.productId ?? '');
    const supplierId = String(
      event.payload.supplierId ?? event.businessId ?? '',
    );
    const delta = Number(event.payload.delta ?? 0);

    if (
      user.role === UserRole.SUPPLIER &&
      user.supplierId &&
      supplierId !== user.supplierId
    ) {
      await this.prisma.syncEvent.create({
        data: {
          eventId: event.eventId,
          deviceId: event.deviceId,
          userId: user.sub,
          businessId: user.supplierId,
          operation: event.operation,
          payloadJson: event.payload as Prisma.InputJsonValue,
          status: SyncEventStatus.CONFLICT,
          message: 'Cannot sync inventory for another supplier',
          clientTs: safeDate(event.timestamp),
        },
      });
      return {
        status: 'CONFLICT' as const,
        message: 'Cannot sync inventory for another supplier',
        eventId: event.eventId,
      };
    }

    if (!productId || !supplierId || Number.isNaN(delta) || delta === 0) {
      await this.prisma.syncEvent.create({
        data: {
          eventId: event.eventId,
          deviceId: event.deviceId,
          userId: event.userId,
          businessId: event.businessId,
          operation: event.operation,
          payloadJson: event.payload as Prisma.InputJsonValue,
          status: SyncEventStatus.CONFLICT,
          message: 'Invalid inventory payload',
          clientTs: safeDate(event.timestamp),
        },
      });
      return {
        status: 'CONFLICT' as const,
        message: 'Invalid inventory payload',
        eventId: event.eventId,
      };
    }

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const product = await tx.product.findUnique({ where: { id: productId } });
        if (!product) {
          throw new InventoryConflict('Product not found');
        }
        if (product.supplierId !== supplierId) {
          throw new InventoryConflict('Supplier does not own this product');
        }

        const next = product.stock + delta;
        if (next < 0) {
          throw new InventoryConflict('Insufficient stock for adjustment');
        }

        const stockStatus = stockStatusFor(next);
        const updated = await tx.product.update({
          where: { id: productId },
          data: { stock: next, stockStatus },
        });

        await tx.inventoryLedger.create({
          data: {
            productId,
            supplierId,
            delta,
            reason: event.operation,
            eventId: event.eventId,
            deviceId: event.deviceId,
            userId: event.userId,
            quantityAfter: next,
          },
        });

        await tx.syncEvent.create({
          data: {
            eventId: event.eventId,
            deviceId: event.deviceId,
            userId: event.userId,
            businessId: event.businessId,
            operation: event.operation,
            payloadJson: event.payload as Prisma.InputJsonValue,
            status: SyncEventStatus.SUCCESS,
            message: `Applied delta ${delta}`,
            clientTs: safeDate(event.timestamp),
          },
        });

        return updated;
      });

      return {
        status: 'SUCCESS' as const,
        eventId: event.eventId,
        productId,
        appliedDelta: delta,
        productStock: result.stock,
      };
    } catch (error) {
      const message =
        error instanceof InventoryConflict
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Inventory sync failed';

      try {
        await this.prisma.syncEvent.create({
          data: {
            eventId: event.eventId,
            deviceId: event.deviceId,
            userId: event.userId,
            businessId: event.businessId,
            operation: event.operation,
            payloadJson: event.payload as Prisma.InputJsonValue,
            status: SyncEventStatus.CONFLICT,
            message,
            clientTs: safeDate(event.timestamp),
          },
        });
      } catch {
        // already stored
      }

      return {
        status: 'CONFLICT' as const,
        message,
        eventId: event.eventId,
        productStock: await this.currentStock(productId),
      };
    }
  }

  async list(user: AuthUser) {
    const where =
      user.role === UserRole.SUPPLIER && user.supplierId
        ? { businessId: user.supplierId }
        : undefined;

    const [events, ledger, products] = await Promise.all([
      this.prisma.syncEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }),
      this.prisma.inventoryLedger.findMany({
        where:
          user.role === UserRole.SUPPLIER && user.supplierId
            ? { supplierId: user.supplierId }
            : undefined,
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.product.findMany({
        where:
          user.role === UserRole.SUPPLIER && user.supplierId
            ? { supplierId: user.supplierId }
            : undefined,
        select: { id: true, name: true, stock: true, supplierId: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      count: events.length,
      events,
      ledger,
      inventory: Object.fromEntries(products.map((p) => [p.id, p.stock])),
    };
  }

  private async currentStock(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { stock: true },
    });
    return product?.stock;
  }
}

class InventoryConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryConflict';
  }
}

function stockStatusFor(stock: number): StockStatus {
  if (stock <= 0) return StockStatus.OUT_OF_STOCK;
  if (stock <= 5) return StockStatus.LOW_STOCK;
  return StockStatus.IN_STOCK;
}

function safeDate(value?: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
