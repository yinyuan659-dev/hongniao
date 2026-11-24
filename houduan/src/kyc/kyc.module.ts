import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { ImModule } from '../im/im.module';
import { KycController } from './kyc.controller';
import { KycService } from './kyc.service';
import { RecoverController } from './recover.controller';
import { RecoverService } from './recover.service';

@Module({
  // AuthModule 提供 JwtAuthGuard + CryptoService + AuthService + DeviceService；AiModule 提供 AiWalletService（扣费）；
  // ImModule 提供 ConnectionRegistry（给其它设备推「有新设备登录」、把被移除的设备踢下线）
  imports: [AuthModule, AiModule, ImModule],
  controllers: [KycController, RecoverController],
  providers: [KycService, RecoverService],
  exports: [KycService],
})
export class KycModule {}
