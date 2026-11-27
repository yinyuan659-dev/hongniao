import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { CallService } from './call.service';

class InviteDto {
  @IsString()
  calleeId!: string;

  /** 1=语音 2=视频 */
  @IsIn([1, 2])
  type!: 1 | 2;
}

class RateDto {
  @IsString()
  callId!: string;

  @IsInt() @Min(0) @Max(100)
  photo!: number;

  @IsInt() @Min(0) @Max(100)
  obedience!: number;

  @IsInt() @Min(0) @Max(100)
  legs!: number;

  @IsInt() @Min(0) @Max(100)
  chest!: number;

  @IsInt() @Min(0) @Max(100)
  skin!: number;
}

class LogDto {
  @IsString()
  callId!: string;

  @IsIn(['android', 'ios', 'web'])
  platform!: string;

  @IsArray() @ArrayMaxSize(500) @IsString({ each: true })
  lines!: string[];
}

@Controller('call')
@UseGuards(JwtAuthGuard)
export class CallController {
  constructor(private readonly calls: CallService) {}

  @Get('config')
  config() {
    return this.calls.getConfig();
  }

  /** 发起视频之前问：和这个人视频要不要牵豆、谁付、我够不够。{ free, perMin, iPay, balance?, minutes?, enough? } */
  @Get('fee')
  fee(@CurrentUser() userId: bigint, @Query('peerId') peerId: string) {
    if (!/^\d{1,19}$/.test(peerId ?? '')) throw new BadRequestException('参数不正确');
    return this.calls.feeFor(userId, BigInt(peerId));
  }

  @Post('invite')
  invite(@CurrentUser() userId: bigint, @Body() dto: InviteDto) {
    return this.calls.invite(userId, BigInt(dto.calleeId), dto.type);
  }

  @Post(':callId/accept')
  accept(@CurrentUser() userId: bigint, @Param('callId') callId: string) {
    return this.calls.accept(userId, callId);
  }

  @Post(':callId/reject')
  reject(@CurrentUser() userId: bigint, @Param('callId') callId: string) {
    return this.calls.reject(userId, callId);
  }

  @Post(':callId/cancel')
  cancel(@CurrentUser() userId: bigint, @Param('callId') callId: string) {
    return this.calls.cancel(userId, callId);
  }

  @Post(':callId/end')
  end(@CurrentUser() userId: bigint, @Param('callId') callId: string) {
    return this.calls.end(userId, callId);
  }

  /** 推流完成通知：转发给对方，对方收到后才开始订阅（保证订阅晚于发布） */
  @Post(':callId/published')
  published(@CurrentUser() userId: bigint, @Param('callId') callId: string) {
    return this.calls.published(userId, callId);
  }

  /** 视频通话结束后男方对女方评分（5 维度各 0-100） */
  @Post('rate')
  rate(@CurrentUser() userId: bigint, @Body() dto: RateDto) {
    return this.calls.rate(userId, dto);
  }

  /** 客户端通话日志上报（双端分批上报，后台按 callId 汇总排查） */
  @Post('log')
  log(@CurrentUser() userId: bigint, @Body() dto: LogDto) {
    return this.calls.appendLog(userId, dto);
  }
}
