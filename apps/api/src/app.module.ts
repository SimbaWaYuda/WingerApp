import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { CommissionsModule } from './commissions/commissions.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { OrdersModule } from './orders/orders.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProductsModule } from './products/products.module';
import { ReviewsModule } from './reviews/reviews.module';
import { StorageModule } from './storage/storage.module';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    StorageModule,
    PrismaModule,
    AuthModule,
    ProductsModule,
    SyncModule,
    OrdersModule,
    CommissionsModule,
    ReviewsModule,
    AnalyticsModule,
    OnboardingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
