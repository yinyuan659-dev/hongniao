import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModuleConfigModule } from '../module/module.module';
import { ImModule } from '../im/im.module';
import { AiModule } from '../ai/ai.module';
import { HnModule } from '../hn/hn.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

@Module({
  imports: [AuthModule, ModuleConfigModule, ImModule, AiModule, HnModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
