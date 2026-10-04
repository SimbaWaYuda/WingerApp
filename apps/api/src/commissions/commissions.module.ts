import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

@Module({
  controllers: [CommissionsController],
  providers: [CommissionsService, AuditService],
  exports: [CommissionsService],
})
export class CommissionsModule {}
