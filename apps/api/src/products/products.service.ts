import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  ReturnRequestStatus,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { AuthUser } from '../auth/auth.types';
import {
  commissionReportRow,
  sumCommissionBuckets,
} from '../commissions/commission.math';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { milesBetween, resolvePlace } from './distance';
import { ProductSearchIndexService } from './product-search-index.service';
import { buildSearchDocument } from './search-document';
import {
  CLOTHING_CATEGORY_NAMES,
  GARMENT_TOKENS,
  isClothingUmbrellaToken,
  keywordTokens,
} from './search-interpret';
import { normalizeCityKey } from '../orders/delivery-fees';

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
  /** Null clears a product rate so the city or supplier rate applies. */
  taxRatePercent?: number | null;
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
  taxRatePercent: number | null;
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
  /** Maximum supplier distance in miles from originCity. */
  maxMiles?: number;
  originCity?: string;
  /** Filled by browse after the mile filter. Not a client field. */
  supplierIds?: string[];
  clothing?: boolean;
  semanticIds?: string[];
};

export type ProductBrowseResult = {
  items: ProductDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** False when a mile filter was asked for but the customer city is unknown. */
  distanceReady?: boolean;
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly searchIndex: ProductSearchIndexService,
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
    const maxMiles = Number(query.maxMiles);
    if (Number.isFinite(maxMiles) && maxMiles > 0) {
      const origin = resolvePlace(query.originCity);
      if (!origin) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          totalPages: 1,
          distanceReady: false,
        };
      }
      query = {
        ...query,
        supplierIds: await this.supplierIdsWithinMiles(origin, maxMiles),
      };
    }
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
      distanceReady: true,
    };
  }

  private async supplierIdsWithinMiles(
    origin: { lat: number; lng: number },
    maxMiles: number,
  ): Promise<string[]> {
    const suppliers = await this.prisma.supplier.findMany({
      where: { latitude: { not: null }, longitude: { not: null } },
      select: { id: true, latitude: true, longitude: true },
    });
    return suppliers
      .filter((supplier) => {
        const latitude = supplier.latitude;
        const longitude = supplier.longitude;
        if (latitude == null || longitude == null) return false;
        return milesBetween(origin, { lat: latitude, lng: longitude }) <= maxMiles;
      })
      .map((supplier) => supplier.id);
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
      standardDeliveryFee: Number(supplier.standardDeliveryFee),
      expressDeliveryFee: Number(supplier.expressDeliveryFee),
      pickupDeliveryFee: Number(supplier.pickupDeliveryFee),
      freeDeliveryThreshold:
        supplier.freeDeliveryThreshold == null
          ? null
          : Number(supplier.freeDeliveryThreshold),
      taxRatePercent: Number(supplier.taxRatePercent),
      taxOnDelivery: supplier.taxOnDelivery,
      carrier: supplier.carrier === 'courier' ? 'courier' : 'supplier',
      courierName: supplier.courierName,
    };
  }

  async getMyDeliveryFees(user: AuthUser) {
    const supplier = await this.requireSupplier(user);
    return this.deliveryFeeResponse(supplier);
  }

  async updateMyDeliveryFees(
    user: AuthUser,
    body: {
      standardDeliveryFee?: number;
      expressDeliveryFee?: number;
      pickupDeliveryFee?: number;
      freeDeliveryThreshold?: number | null;
      taxRatePercent?: number;
      taxOnDelivery?: boolean;
      taxCities?: { city?: string; taxRatePercent?: number }[];
      carrier?: string;
      courierName?: string | null;
    },
  ) {
    const supplier = await this.requireSupplier(user);
    const data: Prisma.SupplierUpdateInput = { deliveryConfigured: true };
    const nextCarrier =
      body.carrier !== undefined ? this.parseCarrier(body.carrier) : supplier.carrier;
    if (body.carrier !== undefined) data.carrier = nextCarrier;
    let nextCourierName = supplier.courierName;
    if ('courierName' in body) {
      nextCourierName = this.parseOptionalCourierName(body.courierName);
      data.courierName = nextCourierName;
    }
    if (nextCarrier === 'courier' && !nextCourierName?.trim()) {
      throw new BadRequestException('Courier name must be from 1 to 80 characters.');
    }
    if (body.standardDeliveryFee !== undefined) {
      data.standardDeliveryFee = this.parseDeliveryFee(body.standardDeliveryFee, 'Standard delivery');
    }
    if (body.expressDeliveryFee !== undefined) {
      data.expressDeliveryFee = this.parseDeliveryFee(body.expressDeliveryFee, 'Express delivery');
    }
    if (body.pickupDeliveryFee !== undefined) {
      data.pickupDeliveryFee = this.parseDeliveryFee(body.pickupDeliveryFee, 'Pickup');
    }
    if ('freeDeliveryThreshold' in body) {
      data.freeDeliveryThreshold =
        body.freeDeliveryThreshold == null
          ? null
          : this.parseDeliveryThreshold(body.freeDeliveryThreshold);
    }
    if (body.taxRatePercent !== undefined) {
      data.taxRatePercent = this.parseTaxRate(body.taxRatePercent);
    }
    if (body.taxOnDelivery !== undefined) {
      data.taxOnDelivery = body.taxOnDelivery === true;
    }
    const taxCities =
      body.taxCities !== undefined ? this.parseTaxCities(body.taxCities) : null;
    const updated = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.supplier.update({
        where: { id: supplier.id },
        data,
      });
      if (taxCities) {
        await tx.supplierCityTax.deleteMany({ where: { supplierId: supplier.id } });
        if (taxCities.length > 0) {
          await tx.supplierCityTax.createMany({
            data: taxCities.map((row) => ({
              supplierId: supplier.id,
              city: row.city,
              cityKey: row.cityKey,
              taxRatePercent: row.taxRatePercent,
            })),
          });
        }
      }
      return saved;
    });
    return this.deliveryFeeResponse(updated);
  }

  private async requireSupplier(user: AuthUser) {
    if (user.role !== UserRole.SUPPLIER || !user.supplierId) {
      throw new ForbiddenException('Supplier account required');
    }
    const supplier = await this.prisma.supplier.findUnique({
      where: { id: user.supplierId },
    });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  private async deliveryFeeResponse(supplier: {
    id: string;
    standardDeliveryFee: Prisma.Decimal;
    expressDeliveryFee: Prisma.Decimal;
    pickupDeliveryFee: Prisma.Decimal;
    freeDeliveryThreshold: Prisma.Decimal | null;
    taxRatePercent: Prisma.Decimal;
    taxOnDelivery: boolean;
    carrier: string;
    courierName: string | null;
  }) {
    const taxCities = await this.prisma.supplierCityTax.findMany({
      where: { supplierId: supplier.id },
      orderBy: { city: 'asc' },
    });
    return {
      standardDeliveryFee: Number(supplier.standardDeliveryFee),
      expressDeliveryFee: Number(supplier.expressDeliveryFee),
      pickupDeliveryFee: Number(supplier.pickupDeliveryFee),
      freeDeliveryThreshold:
        supplier.freeDeliveryThreshold == null
          ? null
          : Number(supplier.freeDeliveryThreshold),
      taxRatePercent: Number(supplier.taxRatePercent),
      taxOnDelivery: supplier.taxOnDelivery,
      taxCities: taxCities.map((row) => ({
        city: row.city,
        taxRatePercent: Number(row.taxRatePercent),
      })),
      carrier: supplier.carrier === 'courier' ? 'courier' : 'supplier',
      courierName: supplier.courierName,
    };
  }

  private parseTaxCities(
    value: unknown,
  ): { city: string; cityKey: string; taxRatePercent: number }[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException('City tax rules must be a list.');
    }
    if (value.length > 30) {
      throw new BadRequestException('A supplier can have at most 30 city tax rates.');
    }
    const seen = new Set<string>();
    const rows: { city: string; cityKey: string; taxRatePercent: number }[] = [];
    for (const entry of value) {
      const raw = entry as { city?: unknown; taxRatePercent?: unknown };
      const city = String(raw.city ?? '').trim().replace(/\s+/g, ' ');
      if (!city || city.length > 60) {
        throw new BadRequestException('Each city tax rule needs a city name of 1 to 60 characters.');
      }
      const cityKey = normalizeCityKey(city);
      if (seen.has(cityKey)) {
        throw new BadRequestException(`Tax for ${city} is listed more than once.`);
      }
      seen.add(cityKey);
      rows.push({
        city,
        cityKey,
        taxRatePercent: this.parseTaxRate(raw.taxRatePercent),
      });
    }
    return rows;
  }

  private parseCarrier(value: unknown): 'supplier' | 'courier' {
    const mode = String(value ?? '').trim().toLowerCase();
    if (mode === 'supplier' || mode === 'courier') return mode;
    throw new BadRequestException('Carrier must be supplier or courier.');
  }

  private parseOptionalCourierName(value: unknown): string | null {
    if (value == null || String(value).trim() === '') return null;
    const name = String(value).trim();
    if (name.length > 80) {
      throw new BadRequestException('Courier name must be from 1 to 80 characters.');
    }
    return name;
  }

  private parseOptionalProductTax(value: unknown): number | null {
    if (value == null || value === '') return null;
    return this.parseTaxRate(value);
  }

  private parseTaxRate(value: unknown): number {
    const rate = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      throw new BadRequestException('Tax rate must be from 0 to 100 percent.');
    }
    return Math.round(rate * 100) / 100;
  }

  private parseDeliveryFee(value: unknown, label: string): number {
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount) || amount < 0 || amount > 9999) {
      throw new BadRequestException(`${label} must be from 0 to 9999 USD. Use 0 for free.`);
    }
    return Math.round(amount * 100) / 100;
  }

  private parseDeliveryThreshold(value: unknown): number {
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
      throw new BadRequestException('Free-delivery amount must be greater than 0 and at most 100000 USD.');
    }
    return Math.round(amount * 100) / 100;
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

    const buckets = sumCommissionBuckets(
      commissions.map((row) => commissionReportRow(row)),
    );

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
      pendingCommission: buckets.pendingCommission,
      recognizedCommission: buckets.recognizedCommission,
      settleableCommission: buckets.settleableCommission,
      reversedCommission: buckets.reversedCommission,
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
        searchText: buildSearchDocument({
          id,
          name,
          brand: (dto.brand?.trim() || supplier.name).slice(0, 80),
          category: (dto.category?.trim() || 'General').slice(0, 80),
          color: (dto.color?.trim() || 'Default').slice(0, 80),
          size: (dto.size?.trim() || 'Standard').slice(0, 80),
          model: (dto.model?.trim() || 'Standard').slice(0, 80),
          description: dto.description?.trim() || '',
          extraSpecs: normalizeExtraSpecs(dto.extraSpecs),
        }),
        taxRatePercent: this.parseOptionalProductTax(dto.taxRatePercent),
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
    await this.searchIndex.refresh({
      id: created.id,
      name: created.name,
      brand: created.brand,
      category: created.category,
      color: created.color,
      size: created.size,
      model: created.model,
      description: created.description,
      extraSpecs: normalizeExtraSpecs(created.extraSpecs),
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
    if (dto.taxRatePercent !== undefined) {
      data.taxRatePercent = this.parseOptionalProductTax(dto.taxRatePercent);
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
    await this.searchIndex.refresh({
      id: updated.id,
      name: updated.name,
      brand: updated.brand,
      category: updated.category,
      color: updated.color,
      size: updated.size,
      model: updated.model,
      description: updated.description,
      extraSpecs: normalizeExtraSpecs(updated.extraSpecs),
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

function clothingMatch(): Prisma.ProductWhereInput {
  return {
    OR: [
      ...CLOTHING_CATEGORY_NAMES.map((name) => ({
        category: { equals: name, mode: 'insensitive' as const },
      })),
      ...GARMENT_TOKENS.flatMap((token) => [
        { name: { contains: token, mode: 'insensitive' as const } },
        { category: { contains: token, mode: 'insensitive' as const } },
      ]),
    ],
  };
}

function buildWhere(query: ProductBrowseQuery): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const q = query.q?.trim();
  let clothingFromQuery = false;
  if (q) {
    const tokens = keywordTokens(q);
    clothingFromQuery = tokens.some((token) => isClothingUmbrellaToken(token));
    const other = tokens.filter((token) => !isClothingUmbrellaToken(token));
    const fields = (token: string): Prisma.ProductWhereInput => ({
      OR: [
        { name: { contains: token, mode: 'insensitive' } },
        { brand: { contains: token, mode: 'insensitive' } },
        { supplierName: { contains: token, mode: 'insensitive' } },
        { category: { contains: token, mode: 'insensitive' } },
        { model: { contains: token, mode: 'insensitive' } },
        { id: { contains: token, mode: 'insensitive' } },
        { color: { contains: token, mode: 'insensitive' } },
        { size: { contains: token, mode: 'insensitive' } },
        { description: { contains: token, mode: 'insensitive' } },
        { searchText: { contains: token, mode: 'insensitive' } },
      ],
    });
    const keywordClause =
      other.length === 1
        ? fields(other[0])
        : other.length > 1
          ? { AND: other.map(fields) }
          : !clothingFromQuery && tokens.length === 0
            ? fields(q)
            : undefined;
    const semanticIds = (query.semanticIds ?? []).filter(Boolean);
    if (keywordClause && semanticIds.length) {
      and.push({ OR: [keywordClause, { id: { in: semanticIds } }] });
    } else if (keywordClause) {
      and.push(keywordClause);
    } else if (semanticIds.length) {
      and.push({ id: { in: semanticIds } });
    }
  }
  if (query.category?.trim()) {
    and.push({ category: { equals: query.category.trim(), mode: 'insensitive' } });
  }
  if ((query.clothing || clothingFromQuery) && !query.category?.trim()) {
    and.push(clothingMatch());
  }
  if (query.brand?.trim()) {
    and.push({ brand: { equals: query.brand.trim(), mode: 'insensitive' } });
  }
  if (query.supplierId?.trim()) {
    and.push({ supplierId: query.supplierId.trim() });
  }
  if (query.supplierIds) {
    and.push({
      supplierId: { in: query.supplierIds.length ? query.supplierIds : ['__none__'] },
    });
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
  taxRatePercent?: { toNumber(): number } | number | null;
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
    taxRatePercent:
      product.taxRatePercent == null
        ? null
        : typeof product.taxRatePercent === 'number'
          ? product.taxRatePercent
          : product.taxRatePercent.toNumber(),
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
