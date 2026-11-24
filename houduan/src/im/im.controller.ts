import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { ImService } from './im.service';
import { MessageService } from './message.service';

function toId(v: unknown): bigint {
  const s = String(v ?? '');
  if (!/^\d{1,19}$/.test(s)) throw new BadRequestException('参数不正确');
  return BigInt(s);
}

function toIds(v: unknown): bigint[] {
  return Array.isArray(v) ? [...new Set(v.map(String))].map(toId) : [];
}

@Controller('im')
@UseGuards(JwtAuthGuard)
export class ImController {
  constructor(
    private readonly im: ImService,
    private readonly msgs: MessageService,
  ) {}

  @Get('conversations')
  conversations(@CurrentUser() userId: bigint) {
    return this.im.listConversations(userId);
  }

  /** 消息页搜索：消息内容 + 全局用户（会话名客户端本地匹配） */
  @Get('search')
  search(@CurrentUser() userId: bigint, @Query('q') q?: string) {
    return this.im.search(userId, q ?? '');
  }

  @Get('messages')
  messages(
    @CurrentUser() userId: bigint,
    @Query('conversationId') conversationId: string,
    @Query('beforeId') beforeId?: string,
    @Query('limit') limit?: string,
    @Query('aroundId') aroundId?: string,
  ) {
    return this.im.listMessages(
      userId,
      BigInt(conversationId),
      beforeId ? BigInt(beforeId) : undefined,
      limit ? Number(limit) : 30,
      aroundId ? BigInt(aroundId) : undefined,
    );
  }

  /** 清空聊天记录：双向删除 */
  @Post('conversations/:id/clear')
  clear(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.im.clearMessages(userId, BigInt(id));
  }

  // ---------- 消息长按菜单 ----------

  /** 删除：forAll=true 为双方删除（只能删自己的消息），否则只删自己这边 */
  @Post('messages/delete')
  deleteMessages(@CurrentUser() userId: bigint, @Body() dto: { conversationId?: string; ids?: string[]; forAll?: boolean }) {
    return this.msgs.deleteMessages(userId, toId(dto?.conversationId), toIds(dto?.ids), !!dto?.forAll);
  }

  /** 转发：targets=[{convType:1, targetId: 对方 userId}] */
  @Post('messages/forward')
  forward(
    @CurrentUser() userId: bigint,
    @Body() dto: { fromConversationId?: string; ids?: string[]; targets?: { convType?: number; targetId: string }[] },
  ) {
    return this.msgs.forward(userId, toId(dto?.fromConversationId), toIds(dto?.ids), Array.isArray(dto?.targets) ? dto.targets : []);
  }

  /** 表情回应：emoji 为空或与已选相同则取消 */
  @Post('messages/:id/react')
  reactMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { emoji?: string }) {
    return this.msgs.react(userId, toId(id), String(dto?.emoji ?? ''));
  }

  @Post('messages/:id/pin')
  pinMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { pin?: boolean }) {
    return this.msgs.pin(userId, toId(id), dto?.pin !== false);
  }

  @Get('conversations/:id/pins')
  pins(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.msgs.pins(userId, toId(id));
  }

  @Get('messages/:id/readers')
  readers(@CurrentUser() userId: bigint, @Param('id') id: string) {
    return this.msgs.readers(userId, toId(id));
  }

  @Post('messages/:id/report')
  reportMessage(@CurrentUser() userId: bigint, @Param('id') id: string, @Body() dto: { reason?: string }) {
    return this.msgs.report(userId, toId(id), String(dto?.reason ?? ''));
  }

  /** 扫邀请名片：按名片码（短号）直接打开单聊 */
  @Post('conversations/open-by-code')
  openByCode(@CurrentUser() userId: bigint, @Body() dto: { code?: string }) {
    return this.im.openByInviteCode(userId, String(dto?.code ?? ''));
  }

  /** 打开与某用户的会话（不存在则创建），返回会话 id */
  @Post('conversations/open/:peerId')
  async open(@CurrentUser() userId: bigint, @Param('peerId') peerId: string) {
    const conv = await this.im.getOrCreateSingleConversation(userId, BigInt(peerId));
    return { conversationId: conv.id };
  }
}
