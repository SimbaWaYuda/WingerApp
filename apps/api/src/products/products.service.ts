import { Injectable, NotFoundException } from '@nestjs/common';
import { StockStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ProductDto = {
  id: string;
  name: string;
  brand: string;
  supplierId: string;
  supplierName: string;
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
};

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query?: string): Promise<ProductDto[]> {
    const q = query?.trim();
    const products = await this.prisma.product.findMany({
      where: q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { supplierName: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { name: 'asc' },
    });
    return products.map(toDto);
  }

  async findOne(id: string): Promise<ProductDto> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return toDto(product);
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
