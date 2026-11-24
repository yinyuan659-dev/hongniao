import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Throttle } from '../common/rate-limit.guard';
import { HnService } from './hn.service';
import { DeepService } from './deep.service';
import { CardService } from './card.service';
import { MatchService } from '../match/match.service';

/** AI 红娘：资料收集（模板聊天）、AI 深聊、相亲画像 */
@Controller('hn')
@UseGuards(JwtAuthGuard)
export class HnController {
  constructor(
    private readonly hn: HnService,
    private readonly deep: DeepService,
    private readonly cards: CardService,
    private readonly match: MatchService,
  ) {}

  /** 题目（按我的性别取男 / 女模板）+ 已有回答 + 进度 + 画像 */
  @Get('interview')
  state(@CurrentUser() userId: bigint) {
    return this.hn.state(userId);
  }

  /** 回答 / 修改一题：{ key, value: string[] }，空数组 = 先不说 */
  @Post('interview/answer')
  answer(@CurrentUser() userId: bigint, @Body() body: { key?: string; value?: unknown }) {
    return this.hn.answer(userId, String(body?.key ?? ''), body?.value);
  }

  /** 确认画像，完成资料收集 */
  @Post('interview/confirm')
  confirm(@CurrentUser() userId: bigint) {
    return this.hn.confirm(userId);
  }

  // ---------- 相亲画像网页 ----------

  /**
   * 画像网页的全部数据：id 写 me 是看自己，写别人的 id 是看别人。
   * 看别人时多一块 match：我和 TA 的关系（底部显示哪种按钮）、共同点、为什么推荐给我。
   */
  @Get('card/:id')
  async card(@CurrentUser() userId: bigint, @Param('id') id: string) {
    if (id !== 'me' && !/^\d{1,19}$/.test(id)) throw new BadRequestException('用户不存在');
    const targetId = id === 'me' ? userId : BigInt(id);
    const card = await this.cards.card(userId, targetId);
    return { ...card, match: card.self ? null : await this.match.forCard(userId, targetId) };
  }

  // ---------- AI 深聊（真的大模型，按用量扣费） ----------

  @Get('deep')
  deepState(@CurrentUser() userId: bigint) {
    return this.deep.state(userId);
  }

  /** 开始（有进行中的就接着聊） */
  @Post('deep/start')
  deepStart(@CurrentUser() userId: bigint) {
    return this.deep.start(userId);
  }

  /** 说一句：{ text } 或 { action: 'skip' | 'next' }；什么都不带 = 让 AI 重新回上一句（上次没回成） */
  @Post('deep/message')
  @Throttle(40, 60)
  deepMessage(@CurrentUser() userId: bigint, @Body() body: { text?: string; action?: string }) {
    return this.deep.message(userId, body ?? {});
  }

  /** 聊完了，整理画像 */
  @Post('deep/finish')
  @Throttle(10, 60)
  deepFinish(@CurrentUser() userId: bigint) {
    return this.deep.finish(userId);
  }

  /** 确认 AI 整理的画像 */
  @Post('deep/confirm')
  deepConfirm(@CurrentUser() userId: bigint) {
    return this.deep.confirm(userId);
  }

  /** 再聊聊 */
  @Post('deep/resume')
  deepResume(@CurrentUser() userId: bigint) {
    return this.deep.resume(userId);
  }

  /** 重新聊（开一场新的） */
  @Post('deep/restart')
  deepRestart(@CurrentUser() userId: bigint) {
    return this.deep.restart(userId);
  }

  /** 手动改 AI 画像里的一项：{ key, value }，value 空 = 删掉这一行 */
  @Post('deep/portrait')
  deepEdit(@CurrentUser() userId: bigint, @Body() body: { key?: string; value?: string }) {
    return this.deep.editPortrait(userId, String(body?.key ?? ''), String(body?.value ?? ''));
  }
}
