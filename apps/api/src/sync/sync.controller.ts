import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuthUser } from '../auth/auth.types';
import { SyncEventDto, SyncService } from './sync.service';

@Controller('sync')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  @Post('events')
  ingest(@CurrentUser() user: AuthUser, @Body() event: SyncEventDto) {
    return this.syncService.ingest(event, user);
  }

  @Get('events')
  @Roles(UserRole.ADMIN, UserRole.SUPPLIER)
  list(@CurrentUser() user: AuthUser) {
    return this.syncService.list(user);
  }
}
