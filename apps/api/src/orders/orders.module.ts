import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { StripeService } from './stripe.service';

@Module({
  imports: [AuthModule, OnboardingModule],
  controllers: [OrdersController],
  providers: [OrdersService, StripeService],
  exports: [OrdersService],
})
export class OrdersModule {}
