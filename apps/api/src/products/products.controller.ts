import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('categories')
  listCategories() {
    return this.productsService.listCategories();
  }

  @Get()
  findAll(
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('brand') brand?: string,
    @Query('supplierId') supplierId?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
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
      minPrice != null ||
      maxPrice != null ||
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
      minPrice: minPrice != null ? Number(minPrice) : undefined,
      maxPrice: maxPrice != null ? Number(maxPrice) : undefined,
      inStock: inStock === '1' || inStock === 'true',
      sort,
      page: page != null ? Number(page) : 1,
      pageSize: pageSize != null ? Number(pageSize) : 24,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productsService.findOne(id);
  }
}
