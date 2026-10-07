import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/auth.types';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('take') take?: string) {
    const n = take != null ? Number(take) : 50;
    return this.notifications.listForUser(
      user.sub,
      Number.isFinite(n) ? n : 50,
    );
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user.sub);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.sub);
  }

  @Patch(':id/read')
  async markRead(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const result = await this.notifications.markRead(user.sub, id);
    if (!result) throw new NotFoundException('Notification not found');
    return result;
  }
}
