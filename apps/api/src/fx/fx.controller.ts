import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { FxService } from './fx.service';

@Controller('fx')
export class FxController {
  constructor(private readonly fx: FxService) {}

  @Get('config')
  config() {
    return this.fx.publicConfig();
  }

  @Get('quote')
  quote(@Query('to') to?: string, @Query('from') from?: string) {
    return this.fx.publicConfig().then((config) =>
      this.fx.quote(from || config.settlementCurrency, to || config.settlementCurrency),
    );
  }

  @Get('rates')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  rates() {
    return this.fx.listRates();
  }

  @Patch('settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateSettings(@CurrentUser() user: AuthUser, @Body() body: {
    settlementCurrency?: string;
    supportedDisplayCurrencies?: string[];
    supportedPaymentCurrencies?: string[];
    fxMaxAgeSeconds?: number;
  }) {
    return this.fx.updateSettings(user, body);
  }

  @Post('rates')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  upsertRate(@CurrentUser() user: AuthUser, @Body() body: {
    baseCurrency?: string;
    quoteCurrency?: string;
    rate?: number;
    source?: string;
  }) {
    return this.fx.upsertRate(user, body);
  }

  @Patch('display-currency')
  @UseGuards(JwtAuthGuard)
  setDisplay(
    @CurrentUser() user: AuthUser,
    @Body() body: { displayCurrency?: string | null },
  ) {
    const code = body.displayCurrency?.trim() ? body.displayCurrency : null;
    return this.fx.setDisplayCurrency(user.sub, code);
  }
}
