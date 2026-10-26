import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductSearchIndexService } from './product-search-index.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { ProductsSearchService } from './products-search.service';
import { SuppliersController } from './suppliers.controller';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, SuppliersController],
  providers: [ProductsService, ProductsSearchService, ProductSearchIndexService],
})
export class ProductsModule {}
