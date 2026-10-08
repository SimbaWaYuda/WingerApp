import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

@Module({
  imports: [AuthModule],
  controllers: [FxController],
  providers: [FxService],
  exports: [FxService],
})
export class FxModule {}
