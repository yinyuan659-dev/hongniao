import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { HnController } from './hn.controller';
import { HnService } from './hn.service';
import { DeepService } from './deep.service';
import { CardService } from './card.service';
import { MatchModule } from '../match/match.module';

@Module({
  imports: [AuthModule, AiModule, MatchModule],
  controllers: [HnController],
  providers: [HnService, DeepService, CardService],
  exports: [HnService, DeepService],
})
export class HnModule {}
