import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import {
  SubmitPaymentProfileDto,
  SupplierPaymentsService,
} from './supplier-payments.service';

@Controller('supplier-payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SupplierPaymentsController {
  constructor(private readonly payments: SupplierPaymentsService) {}

  @Get('me')
  @Roles(UserRole.SUPPLIER)
  getMine(@CurrentUser() user: AuthUser) {
    return this.payments.getMine(user);
  }

  @Post('me')
  @Roles(UserRole.SUPPLIER)
  submitMine(
    @CurrentUser() user: AuthUser,
    @Body() body: SubmitPaymentProfileDto,
  ) {
    return this.payments.submitMine(user, body);
  }

  @Patch('me/preference')
  @Roles(UserRole.SUPPLIER)
  setPreference(
    @CurrentUser() user: AuthUser,
    @Body() body: { preference?: string },
  ) {
    return this.payments.setPreference(user, body.preference ?? '');
  }

  @Get('admin/pending')
  @Roles(UserRole.ADMIN)
  listPending(@CurrentUser() user: AuthUser) {
    return this.payments.listPending(user);
  }

  @Get('admin/suppliers/:supplierId')
  @Roles(UserRole.ADMIN)
  listForSupplier(
    @CurrentUser() user: AuthUser,
    @Param('supplierId') supplierId: string,
  ) {
    return this.payments.listForSupplier(user, supplierId);
  }

  @Post('admin/:id/approve')
  @Roles(UserRole.ADMIN)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reviewNote?: string },
  ) {
    return this.payments.approve(user, id, body?.reviewNote);
  }

  @Post('admin/:id/reject')
  @Roles(UserRole.ADMIN)
  reject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reviewNote?: string },
  ) {
    return this.payments.reject(user, id, body?.reviewNote);
  }

  @Post('admin/:id/suspend')
  @Roles(UserRole.ADMIN)
  suspend(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { reviewNote?: string },
  ) {
    return this.payments.suspend(user, id, body?.reviewNote);
  }
}
