import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { CallController } from './call.controller';
import { CallService } from './call.service';

@Module({
  imports: [AuthModule, ImModule],
  controllers: [CallController],
  providers: [CallService],
})
export class CallModule {}
