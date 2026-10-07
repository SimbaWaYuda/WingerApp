import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CommissionRecognitionStatus,
  OrderStatus,
  Prisma,
  ReturnRequestStatus,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const MAX_PRODUCT_IMAGES = 8;
/** Empty cover — clients show a neutral “no photo” tile (never a fake product shot). */
const DEFAULT_PRODUCT_IMAGE = '';
/** Old default Unsplash headphones URL still treated as “missing photo”. */
const LEGACY_DEFAULT_PRODUCT_IMAGE =
  'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';

const productDetailInclude = {
  supplier: {
    select: {
      verificationStatus: true,
      ratingAvg: true,
      ratingCount: true,
    },
  },
  images: {
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.ProductInclude;

export type ProductSpecDto = {
  label: string;
  value: string;
};

export type UpsertSupplierProductDto = {
  name?: string;
  brand?: string;
  price?: number;
  previousPrice?: number | null;
  category?: string;
  description?: string;
  imageUrl?: string;
  stock?: number;
  model?: string;
  color?: string;
  size?: string;
  battery?: string;
  weight?: string;
  extraSpecs?: ProductSpecDto[];
};

export type ProductImageDto = {
  id: string;
  url: string;
  sortOrder: number;
};

export type ProductDto = {
  id: string;
  name: string;
  brand: string;
  supplierId: string;
  supplierName: string;
  supplierVerified: boolean;
  supplierRatingAvg?: number;
  supplierRatingCount?: number;
  price: number;
  previousPrice?: number;
  rating: number;
  imageUrl: string;
  images: ProductImageDto[];
  category: string;
  model: string;
  color: string;
  size: string;
  battery: string;
  weight: string;
  extraSpecs: ProductSpecDto[];
  description: string;
  stock: number;
  stockStatus: 'inStock' | 'lowStock' | 'outOfStock';
  createdAt?: string;
};

export type UploadedProductFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

export type CategoryDto = {
  name: string;
  productCount: number;
};

export type SupplierFacetDto = {
  id: string;
  name: string;
  productCount: number;
};

export type ProductBrowseQuery = {
  q?: string;
  category?: string;
  brand?: string;
  supplierId?: string;
  color?: string;
  size?: string;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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

  async listSuppliers(): Promise<SupplierFacetDto[]> {
    const grouped = await this.prisma.product.groupBy({
      by: ['supplierId', 'supplierName'],
      _count: { _all: true },
      orderBy: { supplierName: 'asc' },
    });
    return grouped.map((row) => ({
      id: row.supplierId,
      name: row.supplierName,
      productCount: row._count._all,
    }));
  }

  async listColors(): Promise<CategoryDto[]> {
    const grouped = await this.prisma.product.groupBy({
      by: ['color'],
      _count: { _all: true },
      orderBy: { color: 'asc' },
    });
    return grouped
      .filter((row) => row.color.trim().length > 0)
      .map((row) => ({
        name: row.color,
        productCount: row._count._all,
      }));
  }

  async listSizes(): Promise<CategoryDto[]> {
    const grouped = await this.prisma.product.groupBy({
      by: ['size'],
      _count: { _all: true },
      orderBy: { size: 'asc' },
    });
    return grouped
      .filter((row) => row.size.trim().length > 0)
      .map((row) => ({
        name: row.size,
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
        include: productDetailInclude,
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
      include: productDetailInclude,
    });
    if (!product) throw new NotFoundException(`Product ${id} not found`);
    return toDto(product);
  }

  async getSupplierProfile(id: string) {
    const supplier = await this.prisma.supplier.findUnique({
      where: { id },
    });
    if (!supplier) throw new NotFoundException(`Supplier ${id} not found`);
    const productCount = await this.prisma.product.count({
      where: { supplierId: id },
    });
    return {
      id: supplier.id,
      name: supplier.name,
      businessBio: supplier.businessBio,
      deliveryNotes: supplier.deliveryNotes,
      verificationStatus: supplier.verificationStatus,
      verified:
        supplier.verificationStatus === 'APPROVED' ||
        supplier.verificationStatus === 'VERIFIED',
      ratingAvg: supplier.ratingAvg,
      ratingCount: supplier.ratingCount,
      productCount,
      deliveryConfigured: supplier.deliveryConfigured,
    };
  }

  /** Real KPIs for the signed-in supplier (replaces mock dashboard cards). */
  async getSupplierDashboard(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const supplierId = user.supplierId;
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const [productCount, lowStockCount, items, commissions, openReturns] =
      await Promise.all([
        this.prisma.product.count({ where: { supplierId } }),
        this.prisma.product.count({
          where: { supplierId, stock: { lte: 5 } },
        }),
        this.prisma.orderItem.findMany({
          where: {
            supplierId,
            status: { not: OrderStatus.CANCELLED },
          },
          select: {
            quantity: true,
            lineTotal: true,
            status: true,
          },
        }),
        this.prisma.orderItemCommission.findMany({
          where: {
            isDemo: false,
            orderItem: { supplierId },
          },
          select: {
            commissionAmount: true,
            status: true,
          },
        }),
        this.prisma.returnRequest.count({
          where: {
            orderItem: { supplierId },
            status: {
              in: [ReturnRequestStatus.REQUESTED, ReturnRequestStatus.IN_REVIEW],
            },
          },
        }),
      ]);

    let openLines = 0;
    let shippedLines = 0;
    let deliveredLines = 0;
    let grossSales = 0;
    for (const item of items) {
      grossSales += Number(item.lineTotal);
      if (
        item.status === OrderStatus.PROCESSING ||
        item.status === OrderStatus.READY_FOR_PICKUP ||
        item.status === OrderStatus.PARTIAL
      ) {
        openLines += 1;
      } else if (item.status === OrderStatus.SHIPPED) {
        shippedLines += 1;
      } else if (item.status === OrderStatus.DELIVERED) {
        deliveredLines += 1;
      }
    }

    let pendingCommission = 0;
    let settleableCommission = 0;
    for (const row of commissions) {
      const amount = Number(row.commissionAmount);
      if (row.status === CommissionRecognitionStatus.SETTLEABLE) {
        settleableCommission += amount;
      } else {
        pendingCommission += amount;
      }
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      supplierId,
      supplierName: supplier.name,
      productCount,
      lowStockCount,
      openLines,
      shippedLines,
      deliveredLines,
      orderLineCount: items.length,
      grossSales: round(grossSales),
      pendingCommission: round(pendingCommission),
      settleableCommission: round(settleableCommission),
      openReturns,
      ratingAvg: supplier.ratingAvg,
      ratingCount: supplier.ratingCount,
    };
  }

  async listMine(user: AuthUser): Promise<ProductDto[]> {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const products = await this.prisma.product.findMany({
      where: { supplierId: user.supplierId },
      orderBy: { name: 'asc' },
      include: productDetailInclude,
    });
    return products.map(toDto);
  }

  async bulkImportForSupplier(
    items: UpsertSupplierProductDto[],
    user: AuthUser,
  ) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException('products array is required');
    }
    if (items.length > 100) {
      throw new BadRequestException('Import at most 100 products at a time');
    }

    const created: { row: number; id: string; name: string }[] = [];
    const updated: { row: number; id: string; name: string }[] = [];
    const errors: { row: number; name?: string; message: string }[] = [];

    for (let i = 0; i < items.length; i++) {
      const row = i + 1;
      const dto = items[i] ?? {};
      const rowName = dto.name?.trim();
      try {
        const existing = await this.findBulkMatch(user.supplierId!, dto);
        if (existing) {
          const product = await this.updateForSupplier(existing.id, dto, user);
          updated.push({ row, id: product.id, name: product.name });
        } else {
          const product = await this.createForSupplier(dto, user);
          created.push({ row, id: product.id, name: product.name });
        }
      } catch (error) {
        errors.push({
          row,
          name: rowName || undefined,
          message: nestErrorMessage(error),
        });
      }
    }

    return {
      createdCount: created.length,
      updatedCount: updated.length,
      errorCount: errors.length,
      created,
      updated,
      errors,
    };
  }

  /** Match CSV row to an existing catalogue item by model, then name. */
  private async findBulkMatch(
    supplierId: string,
    dto: UpsertSupplierProductDto,
  ) {
    const model = dto.model?.trim();
    if (model) {
      const byModel = await this.prisma.product.findFirst({
        where: {
          supplierId,
          model: { equals: model, mode: 'insensitive' },
        },
      });
      if (byModel) return byModel;
    }
    const name = dto.name?.trim();
    if (!name) return null;
    return this.prisma.product.findFirst({
      where: {
        supplierId,
        name: { equals: name, mode: 'insensitive' },
      },
    });
  }

  async createForSupplier(dto: UpsertSupplierProductDto, user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('name is required');
    const price = Number(dto.price);
    if (!Number.isFinite(price) || price < 0) {
      throw new BadRequestException('price must be a non-negative number');
    }
    const stock = dto.stock != null ? Math.floor(Number(dto.stock)) : 0;
    if (!Number.isFinite(stock) || stock < 0) {
      throw new BadRequestException('stock must be a non-negative integer');
    }

    const supplier = await this.prisma.supplier.findUnique({
      where: { id: user.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');

    const id = buildProductId(name);
    const customImageUrl = dto.imageUrl?.trim();
    const imageUrl = customImageUrl || DEFAULT_PRODUCT_IMAGE;
    const created = await this.prisma.product.create({
      data: {
        id,
        name,
        brand: (dto.brand?.trim() || supplier.name).slice(0, 80),
        supplierId: supplier.id,
        supplierName: supplier.name,
        price: new Prisma.Decimal(price.toFixed(2)),
        previousPrice:
          dto.previousPrice == null
            ? null
            : new Prisma.Decimal(Number(dto.previousPrice).toFixed(2)),
        category: (dto.category?.trim() || 'General').slice(0, 80),
        description: dto.description?.trim() || '',
        imageUrl,
        stock,
        stockStatus: stockStatusFor(stock),
        model: (dto.model?.trim() || 'Standard').slice(0, 80),
        color: (dto.color?.trim() || 'Default').slice(0, 80),
        size: (dto.size?.trim() || 'Standard').slice(0, 80),
        battery: (dto.battery?.trim() || '—').slice(0, 80),
        weight: (dto.weight?.trim() || '—').slice(0, 80),
        extraSpecs: normalizeExtraSpecs(dto.extraSpecs),
        ...(customImageUrl
          ? {
              images: {
                create: {
                  id: `img-${id}`,
                  url: customImageUrl,
                  sortOrder: 0,
                },
              },
            }
          : {}),
      },
      include: productDetailInclude,
    });
    return toDto(created);
  }

  async updateForSupplier(
    id: string,
    dto: UpsertSupplierProductDto,
    user: AuthUser,
  ) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const existing = await this.prisma.product.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Product ${id} not found`);
    if (existing.supplierId !== user.supplierId) {
      throw new ForbiddenException('Cannot edit another supplier product');
    }

    const data: Prisma.ProductUpdateInput = {};
    if (dto.name != null) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      data.name = name;
    }
    if (dto.brand != null) data.brand = dto.brand.trim().slice(0, 80) || existing.brand;
    if (dto.price != null) {
      const price = Number(dto.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException('price must be a non-negative number');
      }
      data.price = new Prisma.Decimal(price.toFixed(2));
    }
    if (dto.previousPrice !== undefined) {
      data.previousPrice =
        dto.previousPrice == null
          ? null
          : new Prisma.Decimal(Number(dto.previousPrice).toFixed(2));
    }
    if (dto.category != null) {
      data.category = dto.category.trim().slice(0, 80) || existing.category;
    }
    if (dto.description != null) data.description = dto.description.trim();
    if (dto.imageUrl != null && dto.imageUrl.trim()) {
      data.imageUrl = dto.imageUrl.trim();
    }
    if (dto.model != null) data.model = dto.model.trim().slice(0, 80) || existing.model;
    if (dto.color != null) data.color = dto.color.trim().slice(0, 80) || existing.color;
    if (dto.size != null) data.size = dto.size.trim().slice(0, 80) || existing.size;
    if (dto.battery != null) data.battery = dto.battery.trim().slice(0, 80) || existing.battery;
    if (dto.weight != null) data.weight = dto.weight.trim().slice(0, 80) || existing.weight;
    if (dto.extraSpecs !== undefined) {
      data.extraSpecs = normalizeExtraSpecs(dto.extraSpecs);
    }
    if (dto.stock != null) {
      const stock = Math.floor(Number(dto.stock));
      if (!Number.isFinite(stock) || stock < 0) {
        throw new BadRequestException('stock must be a non-negative integer');
      }
      data.stock = stock;
      data.stockStatus = stockStatusFor(stock);
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data,
      include: productDetailInclude,
    });
    return toDto(updated);
  }

  async addImages(
    productId: string,
    files: UploadedProductFile[],
    user: AuthUser,
  ): Promise<ProductDto> {
    const product = await this.requireOwnedProduct(productId, user);
    if (!files.length) {
      throw new BadRequestException('At least one image file is required');
    }

    if (isPlaceholderImage(product.imageUrl)) {
      const placeholders = await this.prisma.productImage.findMany({
        where: { productId },
      });
      for (const row of placeholders) {
        if (isPlaceholderImage(row.url)) {
          await this.prisma.productImage.delete({ where: { id: row.id } });
        }
      }
    }

    const existingCount = await this.prisma.productImage.count({
      where: { productId },
    });
    if (existingCount + files.length > MAX_PRODUCT_IMAGES) {
      throw new BadRequestException(
        `A product can have at most ${MAX_PRODUCT_IMAGES} images`,
      );
    }

    let sortOrder = existingCount;
    const createdUrls: string[] = [];
    for (const file of files) {
      assertImageQuality(file);
      const ext = extensionForUpload(file);
      const imageId = randomUUID();
      const filename = `${imageId}${ext}`;
      const url = await this.storage.putProductImage(
        productId,
        filename,
        file.buffer,
        file.mimetype || 'application/octet-stream',
      );
      await this.prisma.productImage.create({
        data: {
          id: imageId,
          productId,
          url,
          sortOrder,
        },
      });
      createdUrls.push(url);
      sortOrder += 1;
    }

    if (createdUrls[0] && (existingCount === 0 || isPlaceholderImage(product.imageUrl))) {
      await this.prisma.product.update({
        where: { id: productId },
        data: { imageUrl: createdUrls[0] },
      });
    }

    return this.findOne(productId);
  }

  async removeImage(
    productId: string,
    imageId: string,
    user: AuthUser,
  ): Promise<ProductDto> {
    await this.requireOwnedProduct(productId, user);
    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });
    if (!image || image.productId !== productId) {
      throw new NotFoundException('Image not found');
    }

    await this.prisma.productImage.delete({ where: { id: imageId } });
    await this.storage.deleteStoredUrl(image.url);

    const remaining = await this.prisma.productImage.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
    });
    await Promise.all(
      remaining.map((row, index) =>
        row.sortOrder === index
          ? Promise.resolve()
          : this.prisma.productImage.update({
              where: { id: row.id },
              data: { sortOrder: index },
            }),
      ),
    );

    const cover = remaining[0]?.url ?? DEFAULT_PRODUCT_IMAGE;
    await this.prisma.product.update({
      where: { id: productId },
      data: { imageUrl: cover },
    });

    return this.findOne(productId);
  }

  private async requireOwnedProduct(productId: string, user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException(`Product ${productId} not found`);
    if (product.supplierId !== user.supplierId) {
      throw new ForbiddenException('Cannot edit another supplier product');
    }
    return product;
  }
}

function stockStatusFor(quantity: number): StockStatus {
  if (quantity <= 0) return StockStatus.OUT_OF_STOCK;
  if (quantity <= 5) return StockStatus.LOW_STOCK;
  return StockStatus.IN_STOCK;
}

function buildProductId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return `p-${slug || 'item'}-${suffix}`;
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
  if (query.color?.trim()) {
    and.push({ color: { equals: query.color.trim(), mode: 'insensitive' } });
  }
  if (query.size?.trim()) {
    and.push({ size: { equals: query.size.trim(), mode: 'insensitive' } });
  }
  if (query.minPrice != null && Number.isFinite(query.minPrice)) {
    and.push({ price: { gte: query.minPrice } });
  }
  if (query.maxPrice != null && Number.isFinite(query.maxPrice)) {
    and.push({ price: { lte: query.maxPrice } });
  }
  if (query.minRating != null && Number.isFinite(query.minRating)) {
    and.push({ rating: { gte: query.minRating } });
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

function nestErrorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message: string | string[] }).message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Import failed';
}

function normalizeExtraSpecs(raw: unknown): ProductSpecDto[] {
  if (!Array.isArray(raw)) return [];
  const specs: ProductSpecDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = String((item as { label?: unknown }).label ?? '').trim();
    const value = String((item as { value?: unknown }).value ?? '').trim();
    if (!label || !value) continue;
    specs.push({
      label: label.slice(0, 80),
      value: value.slice(0, 160),
    });
    if (specs.length >= 20) break;
  }
  return specs;
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
  extraSpecs?: unknown;
  description: string;
  stock: number;
  stockStatus: StockStatus;
  createdAt?: Date;
  images?: { id: string; url: string; sortOrder: number }[];
  supplier?: {
    verificationStatus: string;
    ratingAvg?: number;
    ratingCount?: number;
  } | null;
}): ProductDto {
  const price =
    typeof product.price === 'number' ? product.price : product.price.toNumber();
  const previousPrice =
    product.previousPrice == null
      ? undefined
      : typeof product.previousPrice === 'number'
        ? product.previousPrice
        : product.previousPrice.toNumber();
  const images =
    product.images?.map((image) => ({
      id: image.id,
      url: image.url,
      sortOrder: image.sortOrder,
    })) ??
    (product.imageUrl
      ? [{ id: `cover-${product.id}`, url: product.imageUrl, sortOrder: 0 }]
      : []);
  const imageUrl = product.imageUrl || images[0]?.url || DEFAULT_PRODUCT_IMAGE;

  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    supplierId: product.supplierId,
    supplierName: product.supplierName,
    supplierVerified:
      product.supplier?.verificationStatus === 'APPROVED' ||
      product.supplier?.verificationStatus === 'VERIFIED',
    supplierRatingAvg: product.supplier?.ratingAvg ?? 0,
    supplierRatingCount: product.supplier?.ratingCount ?? 0,
    price,
    previousPrice,
    rating: product.rating,
    imageUrl,
    images,
    category: product.category,
    model: product.model,
    color: product.color,
    size: product.size,
    battery: product.battery,
    weight: product.weight,
    extraSpecs: normalizeExtraSpecs(product.extraSpecs),
    description: product.description,
    stock: product.stock,
    stockStatus: mapStatus(product.stockStatus),
    createdAt: product.createdAt?.toISOString(),
  };
}

function isPlaceholderImage(url: string): boolean {
  const trimmed = (url ?? '').trim();
  return (
    !trimmed ||
    trimmed === DEFAULT_PRODUCT_IMAGE ||
    trimmed === LEGACY_DEFAULT_PRODUCT_IMAGE ||
    trimmed.includes('photo-1505740420928-5e560c06d30e')
  );
}

const MIN_IMAGE_EDGE = 600;
const MIN_IMAGE_BYTES = 20 * 1024;

function assertImageQuality(file: UploadedProductFile) {
  if (!file.buffer?.length || file.buffer.length < MIN_IMAGE_BYTES) {
    throw new BadRequestException(
      'Image is too small. Upload an original photo at least 600×600 px (not a web thumbnail).',
    );
  }
  const size = readImageSize(file.buffer);
  if (size && (size.width < MIN_IMAGE_EDGE || size.height < MIN_IMAGE_EDGE)) {
    throw new BadRequestException(
      `Image is ${size.width}×${size.height}. Upload a clearer photo (at least 600×600 px).`,
    );
  }
}

function readImageSize(
  buffer: Buffer,
): { width: number; height: number } | null {
  // PNG
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // GIF
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46
  ) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  // JPEG — scan for SOF0/SOF2
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (marker === 0xd9 || marker === 0xda) break;
      const size = buffer.readUInt16BE(offset + 2);
      if (size < 2) break;
      offset += 2 + size;
    }
  }
  // WebP VP8X / VP8
  if (
    buffer.length >= 30 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width =
        1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
      const height =
        1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
      return { width, height };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  return null;
}

function extensionForUpload(file: UploadedProductFile): string {
  const fromName = extname(file.originalname || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(fromName)) {
    if (fromName === '.jpeg') return '.jpg';
    if (fromName === '.heic' || fromName === '.heif') return '.jpg';
    return fromName;
  }
  switch ((file.mimetype || '').toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
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
