import { BadRequestException, Body, Controller, Delete, Get, Headers, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { RecoverService } from './recover.service';

/** 设备号：三端生成的都是 and_ / ios_ / web_ 加一串字母数字。带 ~ 的是服务端让出来的占位值，不收 */
function deviceIdOf(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[\w.:-]{8,80}$/.test(s)) throw new BadRequestException('设备信息不对');
  return s;
}

/** 换手机找回 / 并号 / 登录设备（样稿 design/05-recover.html） */
@Controller()
export class RecoverController {
  constructor(private readonly recover: RecoverService) {}

  /**
   * 找回第一步（不用登录）：{ deviceId, name, idNo, metaInfo? }。
   * 先查这张身份证有没有认证过的账号：没有 → { found: false }；有 → 发起刷脸，返回 { found: true, certifyId, url, provider }。
   */
  @Post('recover/start')
  @Throttle(10, 600)
  start(
    @Body() body: { deviceId?: string; name?: string; idNo?: string; metaInfo?: unknown },
    @Headers('user-agent') ua: string | undefined,
    @Req() req: any,
  ) {
    const raw = body?.metaInfo;
    const metaInfo = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
    if (metaInfo.length > 20000) throw new BadRequestException('浏览器环境信息不对，请刷新页面后重试');
    const mobile = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua ?? '');
    const ip = (req.headers?.['x-real-ip'] as string) || req.socket?.remoteAddress || '';
    return this.recover.start(deviceIdOf(body?.deviceId), String(body?.name ?? ''), String(body?.idNo ?? ''), metaInfo, mobile, ip);
  }

  /** 找回第二步（不用登录）：{ deviceId, certifyId }。刷脸通过 → 这台设备登录原来的账号，返回 { passed, token, did, user } */
  @Post('recover/finish')
  @Throttle(30, 600)
  finish(@Body() body: { deviceId?: string; certifyId?: string }, @Headers('user-agent') ua: string | undefined) {
    return this.recover.finish(deviceIdOf(body?.deviceId), String(body?.certifyId ?? ''), ua ?? '');
  }

  /** 并号确认：在新号里刷脸通过后，点「进入原来的账号」。返回老账号的 { token, did, user } */
  @Post('kyc/merge/confirm')
  @UseGuards(JwtAuthGuard)
  @Throttle(10, 600)
  mergeConfirm(@CurrentUser() userId: bigint, @Body() body: { certifyId?: string }, @Req() req: any) {
    return this.recover.mergeConfirm(userId, req.deviceRowId as bigint | undefined, String(body?.certifyId ?? ''));
  }

  /** 登录设备列表 */
  @Get('devices')
  @UseGuards(JwtAuthGuard)
  devices(@CurrentUser() userId: bigint, @Req() req: any) {
    return this.recover.deviceList(userId, req.deviceRowId as bigint | undefined);
  }

  /** 移除一台设备（不能移除正在用的这台） */
  @Delete('devices/:id')
  @UseGuards(JwtAuthGuard)
  @Throttle(20, 600)
  remove(@CurrentUser() userId: bigint, @Param('id') id: string, @Req() req: any) {
    if (!/^\d{1,19}$/.test(id)) throw new BadRequestException('设备不存在');
    return this.recover.removeDevice(userId, BigInt(id), req.deviceRowId as bigint | undefined);
  }
}
