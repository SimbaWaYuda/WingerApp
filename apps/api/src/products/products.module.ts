import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { SuppliersController } from './suppliers.controller';

@Module({
  controllers: [ProductsController, SuppliersController],
  providers: [ProductsService],
})
export class ProductsModule {}
