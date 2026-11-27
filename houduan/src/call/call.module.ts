import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { AiModule } from '../ai/ai.module';
import { CallController } from './call.controller';
import { CallService } from './call.service';

@Module({
  // AiModule：视频按分钟扣牵豆要用钱包（AiWalletService）
  imports: [AuthModule, ImModule, AiModule],
  controllers: [CallController],
  providers: [CallService],
})
export class CallModule {}
