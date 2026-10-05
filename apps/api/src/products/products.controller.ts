import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { UserRole } from '@prisma/client';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import {
  ProductsService,
  UpsertSupplierProductDto,
} from './products.service';

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif',
]);

function isAllowedImageUpload(file: {
  mimetype?: string;
  originalname?: string;
}): boolean {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  // Windows often sends application/octet-stream for valid photos.
  const ext = extname(file.originalname || '').toLowerCase();
  if (
    mime === 'application/octet-stream' ||
    mime === 'binary/octet-stream' ||
    mime === ''
  ) {
    return IMAGE_EXTENSIONS.has(ext);
  }
  return IMAGE_EXTENSIONS.has(ext);
}

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('categories')
  listCategories() {
    return this.productsService.listCategories();
  }

  @Get('brands')
  listBrands() {
    return this.productsService.listBrands();
  }

  @Get('suppliers')
  listSuppliers() {
    return this.productsService.listSuppliers();
  }

  @Get('colors')
  listColors() {
    return this.productsService.listColors();
  }

  @Get('sizes')
  listSizes() {
    return this.productsService.listSizes();
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  listMine(@CurrentUser() user: AuthUser) {
    return this.productsService.listMine(user);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: UpsertSupplierProductDto,
  ) {
    return this.productsService.createForSupplier(body, user);
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  bulkImport(
    @CurrentUser() user: AuthUser,
    @Body() body: { products?: UpsertSupplierProductDto[] },
  ) {
    return this.productsService.bulkImportForSupplier(body?.products ?? [], user);
  }

  @Get()
  findAll(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('brand') brand?: string,
    @Query('supplierId') supplierId?: string,
    @Query('color') color?: string,
    @Query('size') size?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('minRating') minRating?: string,
    @Query('inStock') inStock?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const hasBrowseParams =
      page != null ||
      category != null ||
      brand != null ||
      supplierId != null ||
      color != null ||
      size != null ||
      minPrice != null ||
      maxPrice != null ||
      minRating != null ||
      inStock != null ||
      sort != null ||
      pageSize != null;

    // Preserve legacy clients that expect a bare Product[] from GET /products?q=
    if (!hasBrowseParams) {
      return this.productsService.findAll(q);
    }

    return this.productsService.browse({
      q,
      category,
      brand,
      supplierId,
      color,
      size,
      minPrice: minPrice != null ? Number(minPrice) : undefined,
      maxPrice: maxPrice != null ? Number(maxPrice) : undefined,
      minRating: minRating != null ? Number(minRating) : undefined,
      inStock: inStock === '1' || inStock === 'true',
      sort,
      page: page != null ? Number(page) : 1,
      pageSize: pageSize != null ? Number(pageSize) : 24,
    });
  }

  @Post(':id/images')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  @UseInterceptors(
    FilesInterceptor('files', 8, {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (isAllowedImageUpload(file)) {
          return cb(null, true);
        }
        return cb(
          new BadRequestException(
            'Only image files are allowed (JPG, PNG, WebP, GIF).',
          ) as Error,
          false,
        );
      },
    }),
  )
  uploadImages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productsService.addImages(
      id,
      (files ?? []).map((file) => ({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        buffer: file.buffer,
      })),
      user,
    );
  }

  @Delete(':id/images/:imageId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  removeImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.productsService.removeImage(id, imageId, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UpsertSupplierProductDto,
  ) {
    return this.productsService.updateForSupplier(id, body, user);
  }
}
