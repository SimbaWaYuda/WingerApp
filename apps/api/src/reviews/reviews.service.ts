import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrderStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';

export type CreateSupplierReviewDto = {
  orderId: string;
  supplierId: string;
  rating: number;
  comment?: string;
};

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateSupplierReviewDto, user: AuthUser) {
    if (user.role !== UserRole.CUSTOMER) {
      throw new ForbiddenException('Only customers can rate suppliers');
    }
    const rating = Number(dto.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be an integer from 1 to 5');
    }
    const comment = dto.comment?.trim() || null;
    if (comment && comment.length > 500) {
      throw new BadRequestException('Comment must be 500 characters or fewer');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        OR: [{ id: dto.orderId }, { displayId: dto.orderId }],
        customerId: user.sub,
      },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const supplierItems = order.items.filter(
      (item) => item.supplierId === dto.supplierId,
    );
    if (supplierItems.length === 0) {
      throw new BadRequestException('Supplier is not part of this order');
    }
    const delivered = supplierItems.some(
      (item) => item.status === OrderStatus.DELIVERED,
    );
    if (!delivered) {
      throw new BadRequestException(
        'You can rate a supplier only after their items are delivered',
      );
    }

    const existing = await this.prisma.supplierReview.findUnique({
      where: {
        orderId_supplierId_customerId: {
          orderId: order.id,
          supplierId: dto.supplierId,
          customerId: user.sub,
        },
      },
    });
    if (existing) {
      throw new BadRequestException('You already rated this supplier for this order');
    }

    const supplier = await this.prisma.supplier.findUnique({
      where: { id: dto.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const review = await this.prisma.$transaction(async (tx) => {
      const created = await tx.supplierReview.create({
        data: {
          orderId: order.id,
          customerId: user.sub,
          supplierId: dto.supplierId,
          rating,
          comment,
        },
      });
      const agg = await tx.supplierReview.aggregate({
        where: { supplierId: dto.supplierId },
        _avg: { rating: true },
        _count: { _all: true },
      });
      await tx.supplier.update({
        where: { id: dto.supplierId },
        data: {
          ratingAvg: agg._avg.rating ?? rating,
          ratingCount: agg._count._all,
        },
      });
      return created;
    });

    return {
      id: review.id,
      orderId: order.displayId,
      supplierId: review.supplierId,
      supplierName: supplier.name,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
    };
  }

  async listForSupplier(supplierId: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const reviews = await this.prisma.supplierReview.findMany({
      where: { supplierId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { customer: { select: { name: true } } },
    });

    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      ratingAvg: supplier.ratingAvg,
      ratingCount: supplier.ratingCount,
      reviews: reviews.map((review) => ({
        id: review.id,
        rating: review.rating,
        comment: review.comment,
        customerName: review.customer.name,
        createdAt: review.createdAt.toISOString(),
      })),
    };
  }
}
