import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FxModule } from '../fx/fx.module';
import { AuditService } from './audit.service';
import { CommissionLedgerService } from './commission-ledger.service';
import { CommissionRecognitionRecovery } from './commission-recognition.recovery';
import { CommissionsController } from './commissions.controller';
import { CommissionsService } from './commissions.service';

@Module({
  imports: [AuthModule, FxModule],
  controllers: [CommissionsController],
  providers: [CommissionsService, AuditService, CommissionLedgerService, CommissionRecognitionRecovery],
  exports: [CommissionsService, AuditService, CommissionLedgerService, CommissionRecognitionRecovery],
})
export class CommissionsModule {}
