import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from './audit.service';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

@Module({
  imports: [AuthModule],
  controllers: [CommissionsController],
  providers: [CommissionsService, AuditService],
  exports: [CommissionsService, AuditService],
})
export class CommissionsModule {}
