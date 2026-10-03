import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnalyticsController } from './analytics.controller';
import { MixpanelService } from './mixpanel.service';

@Module({
  imports: [AuthModule],
  controllers: [AnalyticsController],
  providers: [MixpanelService],
  exports: [MixpanelService],
})
export class AnalyticsModule {}
