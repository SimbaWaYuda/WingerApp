import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, StockStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ProductDto = {
  id: string;
  name: string;
  brand: string;
  supplierId: string;
  supplierName: string;
  supplierVerified: boolean;
  price: number;
  previousPrice?: number;
  rating: number;
  imageUrl: string;
  category: string;
  model: string;
  color: string;
  size: string;
  battery: string;
  weight: string;
  description: string;
  stock: number;
  stockStatus: 'inStock' | 'lowStock' | 'outOfStock';
  createdAt?: string;
};

export type CategoryDto = {
  name: string;
  productCount: number;
};

export type ProductBrowseQuery = {
  q?: string;
  category?: string;
  brand?: string;
  supplierId?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  sort?: string;
  page?: number;
  pageSize?: number;
};

export type ProductBrowseResult = {
  items: ProductDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Backward-compatible list used by existing clients. */
  async findAll(query?: string): Promise<ProductDto[]> {
    const result = await this.browse({ q: query, pageSize: 200, page: 1 });
    return result.items;
  }

  async listCategories(): Promise<CategoryDto[]> {
    const grouped = await this.prisma.product.groupBy({
      by: ['category'],
      _count: { _all: true },
      orderBy: { category: 'asc' },
    });
    return grouped.map((row) => ({
      name: row.category,
      productCount: row._count._all,
    }));
  }

  async listBrands(): Promise<CategoryDto[]> {
    const grouped = await this.prisma.product.groupBy({
      by: ['brand'],
      _count: { _all: true },
      orderBy: { brand: 'asc' },
    });
    return grouped.map((row) => ({
      name: row.brand,
      productCount: row._count._all,
    }));
  }

  async browse(query: ProductBrowseQuery = {}): Promise<ProductBrowseResult> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 24));
    const where = buildWhere(query);
    const orderBy = buildOrderBy(query.sort);

    const [total, products] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { supplier: { select: { verificationStatus: true } } },
      }),
    ]);

    return {
      items: products.map(toDto),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { supplier: { select: { verificationStatus: true } } },
    });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return toDto(product);
  }
}

function buildWhere(query: ProductBrowseQuery): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const q = query.q?.trim();
  if (q) {
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { supplierName: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { model: { contains: q, mode: 'insensitive' } },
        { id: { contains: q, mode: 'insensitive' } },
      ],
    });
  }
  if (query.category?.trim()) {
    and.push({ category: { equals: query.category.trim(), mode: 'insensitive' } });
  }
  if (query.brand?.trim()) {
    and.push({ brand: { equals: query.brand.trim(), mode: 'insensitive' } });
  }
  if (query.supplierId?.trim()) {
    and.push({ supplierId: query.supplierId.trim() });
  }
  if (query.minPrice != null && Number.isFinite(query.minPrice)) {
    and.push({ price: { gte: query.minPrice } });
  }
  if (query.maxPrice != null && Number.isFinite(query.maxPrice)) {
    and.push({ price: { lte: query.maxPrice } });
  }
  if (query.inStock) {
    and.push({ stock: { gt: 0 } });
  }
  return and.length ? { AND: and } : {};
}

function buildOrderBy(
  sort?: string,
): Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[] {
  switch ((sort ?? 'relevance').toLowerCase()) {
    case 'price_asc':
      return { price: 'asc' };
    case 'price_desc':
      return { price: 'desc' };
    case 'rating':
    case 'popularity':
      return [{ rating: 'desc' }, { name: 'asc' }];
    case 'newest':
      return { createdAt: 'desc' };
    case 'name':
      return { name: 'asc' };
    case 'relevance':
    default:
      return { name: 'asc' };
  }
}

function toDto(product: {
  id: string;
  name: string;
  brand: string;
  supplierId: string;
  supplierName: string;
  price: { toNumber(): number } | number;
  previousPrice: { toNumber(): number } | number | null;
  rating: number;
  imageUrl: string;
  category: string;
  model: string;
  color: string;
  size: string;
  battery: string;
  weight: string;
  description: string;
  stock: number;
  stockStatus: StockStatus;
  createdAt?: Date;
  supplier?: { verificationStatus: string } | null;
}): ProductDto {
  const price =
    typeof product.price === 'number' ? product.price : product.price.toNumber();
  const previousPrice =
    product.previousPrice == null
      ? undefined
      : typeof product.previousPrice === 'number'
        ? product.previousPrice
        : product.previousPrice.toNumber();

  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    supplierId: product.supplierId,
    supplierName: product.supplierName,
    supplierVerified:
      product.supplier?.verificationStatus === 'APPROVED' ||
      product.supplier?.verificationStatus === 'VERIFIED',
    price,
    previousPrice,
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
    stockStatus: mapStatus(product.stockStatus),
    createdAt: product.createdAt?.toISOString(),
  };
}

function mapStatus(status: StockStatus): ProductDto['stockStatus'] {
  switch (status) {
    case StockStatus.LOW_STOCK:
      return 'lowStock';
    case StockStatus.OUT_OF_STOCK:
      return 'outOfStock';
    default:
      return 'inStock';
  }
}
