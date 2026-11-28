import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AiModule } from '../ai/ai.module';
import { ImModule } from '../im/im.module';
import { TripController } from './trip.controller';
import { TripService } from './trip.service';

/** 领队旅行（第 2 步）。后台接口在 admin.controller.ts 里（AdminModule 引这个模块）。 */
@Module({
  imports: [AuthModule, AiModule, ImModule],
  controllers: [TripController],
  providers: [TripService],
  exports: [TripService],
})
export class TripModule {}
