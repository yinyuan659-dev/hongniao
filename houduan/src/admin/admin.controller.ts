import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Throttle } from '../common/rate-limit.guard';
import { SrsService } from '../srs/srs.service';
import { AppVersionService } from '../module/app-version.service';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { HallTabsService } from '../module/hall-tabs.service';
import { MessageService } from '../im/message.service';
import { GroupService } from '../im/group.service';
import { AiWalletService } from '../ai/ai-wallet.service';
import { DeepService } from '../hn/deep.service';
import { PrismaService } from '../prisma/prisma.service';
import { getMatchConfig, setMatchConfig } from '../common/chat-gate';
import { getKycRequired, setKycRequired } from '../common/kyc-gate';
import { beans, getVideoPriceMicro, setVideoPrice } from '../common/video-fee';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly srs: SrsService,
    private readonly appVersion: AppVersionService,
    private readonly hallTabs: HallTabsService,
    private readonly msgs: MessageService,
    private readonly groups: GroupService,
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

  // ---------- 群聊管理（样稿 design/12-group.html） ----------

  /** 群列表：cat = alive 正常 / dissolved 已解散 / closed 被关闭 / all；q 搜群名、群 id、群主 6 位短号 */
  @Get('groups')
  @UseGuards(AdminGuard)
  groupList(@Query('q') q?: string, @Query('cat') cat?: string, @Query('page') page?: string, @Query('size') size?: string) {
    return this.groups.adminList({ q, cat, page: page ? Number(page) : undefined, size: size ? Number(size) : undefined });
  }

  /** 群成员（含已经退出 / 被移出的） */
  @Get('groups/:id/members')
  @UseGuards(AdminGuard)
  groupMembers(@Param('id') id: string) {
    return this.groups.adminMembers(BigInt(id));
  }

  /** 群里最近的消息（新的在前），beforeId 往前翻 */
  @Get('groups/:id/messages')
  @UseGuards(AdminGuard)
  groupMessages(@Param('id') id: string, @Query('beforeId') beforeId?: string) {
    return this.groups.adminMessages(BigInt(id), beforeId ? BigInt(beforeId) : undefined);
  }

  /** 关闭（违规）/ 恢复：{ closed: true | false } */
  @Post('groups/:id/closed')
  @UseGuards(AdminGuard)
  groupClosed(@Param('id') id: string, @Body() body: { closed?: boolean }) {
    return this.groups.adminSetClosed(BigInt(id), body?.closed !== false);
  }

  /** 把人移出群：{ userId } */
  @Post('groups/:id/remove')
  @UseGuards(AdminGuard)
  groupRemove(@Param('id') id: string, @Body() body: { userId?: string }) {
    return this.groups.adminRemove(BigInt(id), BigInt(String(body?.userId ?? '')));
  }

  /**
   * 建一个测试群（kind=test）：{ owner, name, members?: [], memberLimit?, expireInSec? }，owner / members 是 6 位短号或用户 id。
   * 正式的群只由线路、活动模块建；这个接口只给验证群聊用，测完用下面的删除接口删掉。
   */
  @Post('groups/test')
  @UseGuards(AdminGuard)
  groupCreateTest(@Body() body: { owner?: string; name?: string; members?: string[]; memberLimit?: number; expireInSec?: number }) {
    return this.groups.adminCreateTest(String(body?.owner ?? ''), String(body?.name ?? ''), Array.isArray(body?.members) ? body.members.map(String) : [], {
      memberLimit: body?.memberLimit, expireInSec: body?.expireInSec,
    });
  }

  /** 把一个号加进群（测试用）：{ who } */
  @Post('groups/:id/add')
  @UseGuards(AdminGuard)
  groupAdd(@Param('id') id: string, @Body() body: { who?: string }) {
    return this.groups.adminAdd(BigInt(id), String(body?.who ?? ''));
  }

  /** 彻底删掉一个测试群（只认 kind=test） */
  @Post('groups/:id/delete-test')
  @UseGuards(AdminGuard)
  groupDeleteTest(@Param('id') id: string) {
    return this.groups.adminDeleteTest(BigInt(id));
  }

  // 这里原来有 iOS「审核模式」和演示账号的接口，2026-11-25 删掉了。
  // 应用商店的审核员和普通用户走完全一样的流程（设备号注册）。不要再加任何只在审核期间生效、或者能让 App 换一套界面的开关。

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

  // ---------- 牵豆（原来叫 AI 余额；1 元 = 1 牵豆） ----------

  /**
   * 给账号加牵豆：{ who: 短号或用户 id, yuan: 加多少（牵豆 = 元）, refKey: 批次号, note? }。
   * 同一个批次号只会加一次，重复提交不会多加。收款接好之前，测试号、给审核用的号的牵豆都从这里加（deploy/beans_add.py）。
   */
  @Post('ai-wallet/credit')
  @UseGuards(AdminGuard)
  aiCredit(@Body() body: { who?: string; yuan?: number; refKey?: string; note?: string }) {
    return this.aiWallet.adminCredit(String(body?.who ?? ''), Number(body?.yuan), String(body?.refKey ?? ''), String(body?.note ?? ''));
  }

  // ---------- 视频见面每分钟收多少牵豆 ----------

  /** 现在的价格：{ videoPerMin: "0.02" }（每分钟多少牵豆，只有男方付；"0" = 不收费） */
  @Get('call/fee')
  @UseGuards(AdminGuard)
  async callFee() {
    return { videoPerMin: beans(await getVideoPriceMicro(this.prisma, true)) };
  }

  /**
   * 改价：{ videoPerMin: 0.05 }，0～100，最多 4 位小数，0 = 不收费。改完最多 30 秒生效；正在打的那一通按发起时的价格算完。
   * 没有单独的开关：收费一直是开着的，送审时和上线后价格的显示方式一样。
   */
  @Put('call/fee')
  @UseGuards(AdminGuard)
  async setCallFee(@Body() body: { videoPerMin?: number }) {
    return { videoPerMin: beans(await setVideoPrice(this.prisma, body?.videoPerMin)) };
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

  // ---------- 推荐、喜欢、视频见面的设置 ----------

  /** 现在的设置：每天推荐几位、每天能喜欢几个、视频见面要不要互相喜欢 */
  @Get('match/config')
  @UseGuards(AdminGuard)
  matchConfig() {
    return getMatchConfig(this.prisma, true);
  }

  /**
   * 改设置（只改传进来的项）：
   *   { dailyRecs 每天推荐几位 1～10, dailyLikes 在遇见里每天能喜欢几个 0～50,
   *     videoNeedLike 视频见面要不要互相喜欢 true / false（默认 true；false 是测试用的，送审和正式上线时保持 true） }
   * 改完最多 30 秒生效。videoNeedLike 只决定服务器放不放行视频通话，App 的页面不随它变。
   */
  @Put('match/config')
  @UseGuards(AdminGuard)
  setMatchConfig(@Body() body: { dailyRecs?: number; dailyLikes?: number; videoNeedLike?: boolean }) {
    return setMatchConfig(this.prisma, { dailyRecs: body?.dailyRecs, dailyLikes: body?.dailyLikes, videoNeedLike: body?.videoNeedLike });
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
