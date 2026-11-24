import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiGatewayService } from './ai-gateway.service';
import { AiWalletController } from './ai-wallet.controller';
import { AiWalletService } from './ai-wallet.service';

@Module({
  imports: [AuthModule],
  controllers: [AiController, AiWalletController],
  providers: [AiService, AiGatewayService, AiWalletService],
  exports: [AiGatewayService, AiWalletService],
})
export class AiModule {}
