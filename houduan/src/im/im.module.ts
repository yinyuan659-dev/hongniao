import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectionRegistry } from './connection.registry';
import { ImController } from './im.controller';
import { ImGateway } from './im.gateway';
import { ImService } from './im.service';
import { MessageService } from './message.service';
import { UploadModule } from '../upload/upload.module';

@Module({
  imports: [AuthModule, UploadModule],
  controllers: [ImController],
  providers: [ConnectionRegistry, ImService, ImGateway, MessageService],
  exports: [ConnectionRegistry, ImService, MessageService],
})
export class ImModule {}
