import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '../common/rate-limit.guard';
import { SrsService } from '../srs/srs.service';
import { AppVersionService } from '../module/app-version.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { ReviewService } from '../auth/review.service';
import { HallTabsService } from '../module/hall-tabs.service';
import { MessageService } from '../im/message.service';
import { AiWalletService } from '../ai/ai-wallet.service';
import { DeepService } from '../hn/deep.service';
import { PrismaService } from '../prisma/prisma.service';
import { getMatchConfig, setMatchConfig } from '../common/chat-gate';
import { getKycRequired, setKycRequired } from '../common/kyc-gate';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly srs: SrsService,
    private readonly appVersion: AppVersionService,
    private readonly review: ReviewService,
    private readonly hallTabs: HallTabsService,
    private readonly msgs: MessageService,
    private readonly aiWallet: AiWalletService,
    private readonly deep: DeepService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------- 举报（聊天消息长按举报） ----------

  @Get('reports')
  @UseGuards(AdminGuard)
  reportList(@Query('status') status?: string, @Query('beforeId') beforeId?: string) {
    return this.msgs.adminReports(status === '0' || status === '1' ? Number(status) : undefined, beforeId ? BigInt(beforeId) : undefined);
  }

  @Post('reports/:id/handle')
  @UseGuards(AdminGuard)
  reportHandle(@Param('id') id: string, @Body() body: { action?: string }) {
    return this.msgs.adminHandleReport(BigInt(id), String(body?.action ?? ''));
  }

  // ---------- iOS 审核模式 / 演示账号 ----------

  @Get('review-mode')
  @UseGuards(AdminGuard)
  reviewMode() {
    return this.review.adminStatus();
  }

  /** 开关 iOS 审核模式；开启时自动创建/补足演示账号 */
  @Put('review-mode')
  @UseGuards(AdminGuard)
  setReviewMode(@Body() body: { ios: boolean }) {
    return this.review.setIos(!!body?.ios);
  }

  /** 重建演示账号资料（从第一个男用户重新复制、城市成都、补足积分） */
  @Post('review-mode/demo-user')
  @UseGuards(AdminGuard)
  async rebuildDemo() {
    await this.review.ensureDemoUser(true);
    return this.review.adminStatus();
  }

  // ---------- App 版本 / 强制更新 ----------

  @Get('app-version')
  @UseGuards(AdminGuard)
  appVersions() {
    return this.appVersion.adminList();
  }

  @Put('app-version/:platform')
  @UseGuards(AdminGuard)
  saveAppVersion(
    @Param('platform') platform: string,
    @Body() body: { latest?: string; minVersion?: string; force?: boolean; url?: string; channel?: string; notes?: string },
  ) {
    return this.appVersion.adminSave(platform, body);
  }

  // ---------- SRS 节点管理 ----------

  /** 节点列表 + 当前连接数 + 环境变量兜底值 */
  @Get('srs-nodes')
  @UseGuards(AdminGuard)
  srsNodes() {
    return this.srs.adminList();
  }

  /** 默认（源）节点：部署工具拉这个决定从哪台复制 */
  @Get('srs-nodes/default')
  @UseGuards(AdminGuard)
  srsDefault() {
    return this.srs.defaultNode();
  }

  @Post('srs-nodes')
  @UseGuards(AdminGuard)
  srsCreate(@Body() body: any) {
    return this.srs.adminCreate(body);
  }

  @Post('srs-nodes/:id')
  @UseGuards(AdminGuard)
  srsUpdate(@Param('id') id: string, @Body() body: any) {
    return this.srs.adminUpdate(Number(id), body);
  }

  @Post('srs-nodes/:id/default')
  @UseGuards(AdminGuard)
  srsSetDefault(@Param('id') id: string) {
    return this.srs.adminSetDefault(Number(id));
  }

  @Post('srs-nodes/:id/delete')
  @UseGuards(AdminGuard)
  srsDelete(@Param('id') id: string) {
    return this.srs.adminDelete(Number(id));
  }

  @Post('login')
  @Throttle(10, 300)
  login(@Body() body: { username: string; password: string }, @Req() req: Request) {
    const ip = (req.headers['x-real-ip'] as string) || req.socket?.remoteAddress || '';
    return this.admin.login(body.username, body.password, ip);
  }

  // ---------- AI 余额 ----------

  /**
   * 给账号加 AI 余额：{ who: 短号或用户 id, yuan: 元, refKey: 批次号, note? }。
   * 同一个批次号只会加一次，重复提交不会多加。
   */
  @Post('ai-wallet/credit')
  @UseGuards(AdminGuard)
  aiCredit(@Body() body: { who?: string; yuan?: number; refKey?: string; note?: string }) {
    return this.aiWallet.adminCredit(String(body?.who ?? ''), Number(body?.yuan), String(body?.refKey ?? ''), String(body?.note ?? ''));
  }

  /**
   * 清掉某个人画像里「需要注意」的记录：{ userId }。
   * 那些记录是 AI 在深聊里听本人说的，本人自己改不了；AI 记错了只能后台核实后在这里清。
   */
  @Post('hn/flags/clear')
  @UseGuards(AdminGuard)
  clearFlags(@Body() body: { userId?: string }) {
    return this.deep.clearFlags(BigInt(String(body?.userId ?? '0')));
  }

  // ---------- 推荐、喜欢、聊天限制的设置 ----------

  /** 现在的设置：每天推荐几位、每天能喜欢几个、老聊天保留几天、规则是哪天上线的 */
  @Get('match/config')
  @UseGuards(AdminGuard)
  matchConfig() {
    return getMatchConfig(this.prisma, true);
  }

  /**
   * 改设置（只改传进来的项）：{ dailyRecs 每天推荐几位 1～10, dailyLikes 在遇见里每天能喜欢几个 0～50, legacyDays 老聊天保留几天 0～365 }。
   * 改完最多 30 秒生效。
   */
  @Put('match/config')
  @UseGuards(AdminGuard)
  setMatchConfig(@Body() body: { dailyRecs?: number; dailyLikes?: number; legacyDays?: number }) {
    return setMatchConfig(this.prisma, { dailyRecs: body?.dailyRecs, dailyLikes: body?.dailyLikes, legacyDays: body?.legacyDays });
  }

  // ---------- 实人认证开关 ----------

  /** 是否要求实人认证才能聊天 / 发动态 / 评论（默认关；支付上线前先关着用测试号走流程） */
  @Get('kyc/config')
  @UseGuards(AdminGuard)
  async kycConfig() {
    return { required: await getKycRequired(this.prisma, true) };
  }

  /** 打开 / 关闭实人认证门槛：{ required: boolean }，改完最多 30 秒生效 */
  @Put('kyc/config')
  @UseGuards(AdminGuard)
  async setKycConfig(@Body() body: { required?: boolean }) {
    return { required: await setKycRequired(this.prisma, !!body?.required) };
  }

  // ---------- 用户 ----------

  @Get('users')
  @UseGuards(AdminGuard)
  users(@Query('keyword') keyword?: string, @Query('cat') cat?: string, @Query('page') page?: string, @Query('size') size?: string) {
    return this.admin.listUsers(keyword?.trim() || undefined, cat, Number(page) || 1, Number(size) || 20);
  }

  @Post('users/:id/hidden')
  @UseGuards(AdminGuard)
  setUserHidden(@Param('id') id: string, @Body() body: { hidden?: boolean }) {
    return this.admin.setUserHidden(BigInt(id), !!body?.hidden);
  }

  @Post('users/:id/status')
  @UseGuards(AdminGuard)
  setStatus(@Param('id') id: string, @Body() body: { status: number }) {
    return this.admin.setUserStatus(BigInt(id), body.status);
  }

  // ---------- 通话日志 ----------

  @Get('call-logs')
  @UseGuards(AdminGuard)
  callLogs(@Query('beforeId') beforeId?: string) {
    return this.admin.listCallLogs(beforeId ? BigInt(beforeId) : undefined);
  }

  @Get('call-logs/:callId')
  @UseGuards(AdminGuard)
  callLogDetail(@Param('callId') callId: string) {
    return this.admin.callLogDetail(callId);
  }

  // ---------- 通话参数 ----------

  @Get('call-config')
  @UseGuards(AdminGuard)
  getCallConfig() {
    return this.admin.getCallConfig();
  }

  @Put('call-config')
  @UseGuards(AdminGuard)
  callConfig(@Body() body: { width?: number; height?: number; fps?: number; bitrate?: number }) {
    return this.admin.updateCallConfig(body);
  }

  // ---------- 开关配置（计费字段已不用，只剩 momentNeedRealname） ----------

  @Get('price-config')
  @UseGuards(AdminGuard)
  priceConfig() {
    return this.admin.getPriceConfig();
  }

  @Put('price-config')
  @UseGuards(AdminGuard)
  updatePriceConfig(@Body() body: { msgPriceFen?: number; videoBaseFenPerMin?: number; videoPlatformX?: number; momentNeedRealname?: boolean }) {
    return this.admin.updatePriceConfig(body);
  }

  // ---------- 模块入口 ----------

  @Get('modules')
  @UseGuards(AdminGuard)
  modules() {
    return this.admin.listModules();
  }

  /** 大厅 tab 顺序 */
  @Get('hall-tabs')
  @UseGuards(AdminGuard)
  async hallTabOrder() {
    return { order: await this.hallTabs.order() };
  }

  @Put('hall-tabs')
  @UseGuards(AdminGuard)
  async saveHallTabs(@Body() body: { order?: string[] }) {
    return { order: await this.hallTabs.save(body?.order) };
  }

  @Post('modules')
  @UseGuards(AdminGuard)
  upsertModule(
    @Body() body: {
      id?: number; name: string; nameEn?: string; icon?: string; desc?: string; descEn?: string; cover?: string; type: string; entry: string;
      orientation?: string; sort?: number; enabled?: boolean; visibleGender?: number;
    },
  ) {
    return this.admin.upsertModule(body);
  }

  // ---------- 动态 ----------

  @Post('moments/:id/hide')
  @UseGuards(AdminGuard)
  hideMoment(@Param('id') id: string) {
    return this.admin.hideMoment(BigInt(id));
  }
}
