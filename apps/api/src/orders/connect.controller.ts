import {
  Controller,
  Get,
  Header,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { PayoutsService } from './payouts.service';

@Controller('payments')
export class ConnectController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('connect/return')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async returned(@Query('state') state = '') {
    await this.payouts.syncByState(state);
    return `<!DOCTYPE html><html><body style="font-family:Segoe UI,sans-serif;color:#1F4D43;padding:24px">
      <h1>Payout setup saved</h1>
      <p>Return to Winger and refresh payout status.</p>
    </body></html>`;
  }

  @Get('connect/refresh')
  async refreshed(@Query('state') state = '', @Res() res: Response) {
    const url = await this.payouts.refreshLink(state);
    res.redirect(url);
  }
}

@Controller('suppliers/me/connect')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPPLIER)
export class SupplierConnectController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  status(@CurrentUser() user: AuthUser) {
    return this.payouts.status(user);
  }

  @Post()
  start(@CurrentUser() user: AuthUser) {
    return this.payouts.startOnboarding(user);
  }

  @Post('transfers')
  transfers(@CurrentUser() user: AuthUser) {
    return this.payouts.transferSettleableForSupplier(user);
  }
}
