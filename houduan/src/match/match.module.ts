import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { ImModule } from '../im/im.module';
import { MatchController } from './match.controller';
import { MatchService } from './match.service';

@Module({
  imports: [AuthModule, AiModule, ImModule],
  controllers: [MatchController],
  providers: [MatchService],
  exports: [MatchService],
})
export class MatchModule {}
