import { BadRequestException, Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { KycService } from './kyc.service';

/** 实人认证（身份证 + 刷脸）：并进基础画像的最后一步 */
@Controller('kyc')
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  /** 状态：有没有认证过、后台要不要求、费用、余额 */
  @Get('status')
  status(@CurrentUser() userId: bigint) {
    return this.kyc.status(userId);
  }

  /**
   * 发起：{ name, idNo, metaInfo? }，校验通过后返回刷脸页地址。
   * metaInfo 是网页端用阿里云的 getMetaInfo() 取到的浏览器环境参数（对象或 JSON 字符串都行），真实刷脸才需要。
   */
  @Post('start')
  @Throttle(10, 600)
  start(
    @CurrentUser() userId: bigint,
    @Body() body: { name?: string; idNo?: string; metaInfo?: unknown },
    @Headers('user-agent') ua?: string,
  ) {
    const raw = body?.metaInfo;
    const metaInfo = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
    if (metaInfo.length > 20000) throw new BadRequestException('浏览器环境信息不对，请刷新页面后重试');
    const mobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua ?? '');
    return this.kyc.start(userId, String(body?.name ?? ''), String(body?.idNo ?? ''), metaInfo, mobile);
  }

  /** 刷脸结束后查结果：{ certifyId } */
  @Post('finish')
  @Throttle(20, 600)
  finish(@CurrentUser() userId: bigint, @Body() body: { certifyId?: string }) {
    return this.kyc.finish(userId, String(body?.certifyId ?? ''));
  }
}
