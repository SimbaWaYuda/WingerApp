import { Controller, Get, Param } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly productsService: ProductsService) {}

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.productsService.getSupplierProfile(id);
  }
}
