import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser } from '../auth/auth.types';
import { MixpanelService } from './mixpanel.service';

const ALLOWED = new Set([
  'onboarding_started',
  'onboarding_step_completed',
  'onboarding_completed',
  'first_meaningful_action',
]);

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private readonly mixpanel: MixpanelService) {}

  @Post('events')
  async track(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      event?: string;
      properties?: Record<string, string | number | boolean>;
    },
  ) {
    const event = body.event?.trim() || '';
    if (!ALLOWED.has(event)) {
      return { ok: false, reason: 'event_not_allowed' };
    }
    await this.mixpanel.track(event, user.sub, {
      role: user.role,
      ...(body.properties ?? {}),
    });
    return { ok: true };
  }
}
