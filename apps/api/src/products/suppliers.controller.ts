import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { ProductsService } from './products.service';

@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly productsService: ProductsService) {}

  @Get('me/dashboard')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  dashboard(@CurrentUser() user: AuthUser) {
    return this.productsService.getSupplierDashboard(user);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.productsService.getSupplierProfile(id);
  }
}
