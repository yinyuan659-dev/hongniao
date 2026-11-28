import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './common/rate-limit.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ModuleConfigModule } from './module/module.module';
import { ImModule } from './im/im.module';
import { UploadModule } from './upload/upload.module';
import { CallModule } from './call/call.module';
import { MomentModule } from './moment/moment.module';
import { AdminModule } from './admin/admin.module';
import { NotifyModule } from './notify/notify.module';
import { IntimacyModule } from './intimacy/intimacy.module';
import { AiModule } from './ai/ai.module';
import { SrsModule } from './srs/srs.module';
import { InviteModule } from './invite/invite.module';
import { EmojiModule } from './emoji/emoji.module';
import { GeoModule } from './geo/geo.module';
import { HnModule } from './hn/hn.module';
import { MatchModule } from './match/match.module';
import { KycModule } from './kyc/kyc.module';
import { TripModule } from './trip/trip.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    SrsModule,
    AuthModule,
    UserModule,
    ModuleConfigModule,
    ImModule,
    UploadModule,
    CallModule,
    MomentModule,
    AdminModule,
    NotifyModule,
    IntimacyModule,
    AiModule,
    InviteModule,
    EmojiModule,
    GeoModule,
    HnModule,
    MatchModule,
    KycModule,
    TripModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
