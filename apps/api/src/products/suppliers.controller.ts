import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
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

  @Get('me/delivery')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  deliveryFees(@CurrentUser() user: AuthUser) {
    return this.productsService.getMyDeliveryFees(user);
  }

  @Patch('me/delivery')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPPLIER)
  updateDeliveryFees(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      standardDeliveryFee?: number;
      expressDeliveryFee?: number;
      pickupDeliveryFee?: number;
      freeDeliveryThreshold?: number | null;
      taxRatePercent?: number;
      taxOnDelivery?: boolean;
      carrier?: string;
      courierName?: string | null;
    },
  ) {
    return this.productsService.updateMyDeliveryFees(user, body);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.productsService.getSupplierProfile(id);
  }
}
