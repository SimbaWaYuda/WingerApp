import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import {
  CommissionsService,
  CounterAgreementDto,
  ProposeAgreementDto,
  UpdateDefaultCommissionDto,
} from './commissions.service';

@Controller('commissions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Get('settings')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  getSettings() {
    return this.commissions.getSettings();
  }

  @Patch('settings/default-rate')
  @Roles(UserRole.ADMIN)
  updateDefault(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateDefaultCommissionDto,
  ) {
    return this.commissions.updateDefaultCommission(body, user);
  }

  @Get('agreements')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  listAgreements(
    @CurrentUser() user: AuthUser,
    @Query('supplierId') supplierId?: string,
  ) {
    return this.commissions.listAgreements(user, supplierId);
  }

  @Post('agreements')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  propose(@CurrentUser() user: AuthUser, @Body() body: ProposeAgreementDto) {
    return this.commissions.propose(body, user);
  }

  @Post('agreements/:id/counter')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  counter(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: CounterAgreementDto,
  ) {
    return this.commissions.counter(id, body, user);
  }

  @Post('agreements/:id/approve')
  @Roles(UserRole.ADMIN)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.approve(id, user);
  }

  @Post('agreements/:id/accept')
  @Roles(UserRole.SUPPLIER)
  accept(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.accept(id, user);
  }

  @Post('agreements/:id/reject')
  @Roles(UserRole.ADMIN)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.commissions.reject(id, user);
  }

  @Get('audit')
  @Roles(UserRole.ADMIN)
  audit(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType: string,
    @Query('entityId') entityId: string,
  ) {
    return this.commissions.listAudit(
      entityType || 'PlatformSettings',
      entityId || 'default',
      user,
    );
  }

  @Get('admin/supplier-totals')
  @Roles(UserRole.ADMIN)
  adminSupplierTotals(@CurrentUser() user: AuthUser) {
    return this.commissions.listAdminSupplierTotals(user);
  }

  @Get('supplier/summary')
  @Roles(UserRole.SUPPLIER)
  supplierSummary(@CurrentUser() user: AuthUser) {
    return this.commissions.listSupplierCommissionSummary(user);
  }
}
