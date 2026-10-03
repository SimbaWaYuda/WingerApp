import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/auth.types';
import { OnboardingService } from './onboarding.service';

@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.onboarding.getProgress(user);
  }

  @Post('start')
  start(@CurrentUser() user: AuthUser) {
    return this.onboarding.start(user);
  }

  @Post('dismiss')
  dismiss(@CurrentUser() user: AuthUser) {
    return this.onboarding.dismiss(user);
  }

  @Post('resume')
  resume(@CurrentUser() user: AuthUser) {
    return this.onboarding.resume(user);
  }

  @Post('tasks/complete')
  complete(
    @CurrentUser() user: AuthUser,
    @Body() body: { key?: string },
  ) {
    return this.onboarding.completeTask(user, body.key ?? '');
  }

  @Post('tasks/skip')
  skip(
    @CurrentUser() user: AuthUser,
    @Body() body: { key?: string },
  ) {
    return this.onboarding.skipTask(user, body.key ?? '');
  }

  @Post('activity')
  activity(
    @CurrentUser() user: AuthUser,
    @Body() body: { flag?: string },
  ) {
    return this.onboarding.stampActivity(user, body.flag ?? '');
  }

  @Post('profile')
  profile(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: string;
      phone?: string;
      city?: string;
      addressLine?: string;
    },
  ) {
    return this.onboarding.updateProfile(user, body);
  }

  @Post('preferences')
  preferences(
    @CurrentUser() user: AuthUser,
    @Body() body: { locale?: string },
  ) {
    return this.onboarding.updatePreferences(user, body);
  }

  @Post('supplier/business')
  supplierBusiness(
    @CurrentUser() user: AuthUser,
    @Body() body: { businessBio?: string; name?: string },
  ) {
    return this.onboarding.updateSupplierBusiness(user, body);
  }

  @Post('supplier/verification')
  supplierVerification(@CurrentUser() user: AuthUser) {
    return this.onboarding.submitSupplierVerification(user);
  }

  @Post('supplier/payout')
  supplierPayout(@CurrentUser() user: AuthUser) {
    return this.onboarding.setupSupplierPayout(user);
  }

  @Post('supplier/delivery')
  supplierDelivery(
    @CurrentUser() user: AuthUser,
    @Body() body: { notes?: string },
  ) {
    return this.onboarding.setupSupplierDelivery(user, body);
  }

  @Post('admin/platform')
  adminPlatform(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      setupComplete?: boolean;
      permissionsSeeded?: boolean;
      deliveryConfigured?: boolean;
      paymentsConfigured?: boolean;
      commissionsConfigured?: boolean;
      currency?: string;
      timezone?: string;
    },
  ) {
    return this.onboarding.updatePlatform(user, body);
  }

  @Post('admin/approve-supplier/:supplierId')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('supplierId') supplierId: string,
  ) {
    return this.onboarding.approveSupplier(user, supplierId);
  }
}
