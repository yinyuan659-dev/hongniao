import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { AiGatewayService } from './ai-gateway.service';
import { AiWalletService } from './ai-wallet.service';

const KEY_FAIL: Record<string, string> = {
  key_invalid: '这个 Key 用不了，请检查有没有复制完整',
  key_no_balance: '这个 Key 在 DeepSeek 那边没有额度了，请先去充值',
  ai_down: '暂时连不上 DeepSeek，请稍后再试',
};

/** AI 费用：余额、付费方式（平台余额 / 自己的 Key）、明细 */
@Controller('ai-wallet')
@UseGuards(JwtAuthGuard)
export class AiWalletController {
  constructor(
    private readonly wallet: AiWalletService,
    private readonly gateway: AiGatewayService,
  ) {}

  @Get()
  view(@CurrentUser() userId: bigint) {
    return this.wallet.view(userId);
  }

  /** 切换付费方式：{ payMode: 'platform' | 'own' } */
  @Put('mode')
  setMode(@CurrentUser() userId: bigint, @Body() body: { payMode?: string }) {
    return this.wallet.setMode(userId, String(body?.payMode ?? ''));
  }

  /** 自己的 Key 用不了时是否自动改用平台余额：{ on: boolean } */
  @Put('auto-fallback')
  setAutoFallback(@CurrentUser() userId: bigint, @Body() body: { on?: boolean }) {
    return this.wallet.setAutoFallback(userId, !!body?.on);
  }

  /** 测试并保存自己的 Key：真的调一次 DeepSeek，能用才保存 */
  @Post('key')
  @Throttle(10, 600)
  async saveKey(@CurrentUser() userId: bigint, @Body() body: { key?: string }) {
    const key = String(body?.key ?? '').trim();
    if (!/^sk-[A-Za-z0-9_-]{16,200}$/.test(key)) throw new BadRequestException('Key 的格式不对，应该是 sk- 开头的一串');
    const fail = await this.gateway.testKey(key);
    if (fail) throw new BadRequestException(KEY_FAIL[fail]);
    return this.wallet.saveKey(userId, key);
  }

  /** 重新测试已经保存的 Key */
  @Post('key/test')
  @Throttle(10, 600)
  async retest(@CurrentUser() userId: bigint) {
    const w = await this.wallet.get(userId);
    if (!w.keyEnc) throw new BadRequestException('还没有填写 Key');
    const fail = await this.gateway.testKey(this.wallet.openKey(w.keyEnc));
    if (fail) throw new BadRequestException(KEY_FAIL[fail]);
    return this.wallet.markKeyChecked(userId);
  }

  @Delete('key')
  deleteKey(@CurrentUser() userId: bigint) {
    return this.wallet.deleteKey(userId);
  }

  /** 费用明细：?month=2026-11&kind=all|spend|topup */
  @Get('ledger')
  ledger(@CurrentUser() userId: bigint, @Query('month') month?: string, @Query('kind') kind?: string) {
    return this.wallet.ledger(userId, month, kind);
  }

  /** 一条明细的用量详情 */
  @Get('usage/:groupKey')
  usage(@CurrentUser() userId: bigint, @Param('groupKey') groupKey: string) {
    return this.wallet.usageDetail(userId, groupKey);
  }
}
