import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { AuthModule } from '../auth/auth.module';
import { ImModule } from '../im/im.module';
import { HnModule } from '../hn/hn.module';

@Module({
  imports: [AuthModule, ImModule, HnModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
