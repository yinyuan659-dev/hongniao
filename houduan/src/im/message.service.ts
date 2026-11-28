import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectionRegistry } from './connection.registry';
import { ImService } from './im.service';
import { UploadService } from '../upload/upload.service';
import { GroupService } from './group.service';

/** 聊天里长按消息可选的表情；前 7 个是菜单顶上那一排 */
export const MSG_REACTIONS = ['❤️', '👍', '👎', '🔥', '🥰', '👏', '😁', '😂', '😮', '😢', '🎉', '🙏'];
/** 能转发的消息类型（通话记录不能转发） */
const FORWARDABLE = new Set(['text', 'image', 'video', 'audio', 'file', 'location']);
/** 用户上传目录里的文件地址 */
const MEDIA_RE = /\/res\/[\w.-]+\/(?:image|video|audio|file)\/[\w./-]+/g;
const MAX_BATCH = 100;
const MAX_FORWARD_TARGETS = 10;

type Conv = { id: bigint; userAId: bigint | null; userBId: bigint | null; groupId: bigint | null; wrappedKey: string };

/**
 * 消息长按菜单：删除（自己 / 双方）、转发、表情回应、置顶、已读详情、举报。
 * 群聊里也是这一套，几处不一样：表情、置顶要还在群里；置顶只有群主能点；没有「已读」；灰色小字（sys）不能转发、不能举报。
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly im: ImService,
    private readonly uploads: UploadService,
    private readonly groups: GroupService,
  ) {}

  /** 转发的图片 / 视频 / 语音 / 文件复制一份新文件：两边不共用同一个文件 */
  private async copyMedia(type: string, content: string) {
    if (type !== 'image' && type !== 'video' && type !== 'audio' && type !== 'file') return content;
    let out = content;
    for (const u of new Set(content.match(MEDIA_RE) ?? [])) out = out.split(u).join(await this.uploads.copy(u));
    return out;
  }

  // ---------- 删除 ----------

  /**
   * forAll=true：为双方删除（物理删除并推送 msg_delete）。只能删自己的消息，不限时间。
   * forAll=false：只在自己这边隐藏，对方还能看到。
   */
  async deleteMessages(userId: bigint, conversationId: bigint, ids: bigint[], forAll: boolean) {
    if (!ids.length) throw new BadRequestException('没有选中消息');
    if (ids.length > MAX_BATCH) throw new BadRequestException(`一次最多 ${MAX_BATCH} 条`);
    const conv = await this.ctx(userId, conversationId);

    const msgs = await this.prisma.message.findMany({ where: { id: { in: ids }, conversationId } });
    if (!msgs.length) throw new NotFoundException('消息不存在');

    if (forAll) {
      for (const m of msgs) {
        if (m.senderId !== userId) throw new ForbiddenException('只能为双方删除自己发的消息');
      }
      await this.purge(conv, msgs.map((m) => m.id));
      return { deleted: msgs.length, forAll: true };
    }

    await this.prisma.messageHide.createMany({
      data: msgs.map((m) => ({ userId, messageId: m.id, conversationId })),
      skipDuplicates: true,
    });
    // 只删自己这边的未读消息也算读过，免得红点消不掉
    await this.prisma.message.updateMany({
      where: { id: { in: msgs.map((m) => m.id) }, receiverId: userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    const cid = conversationId.toString();
    for (const m of msgs) await this.registry.deliver([userId], { op: 'msg_delete', data: { conversationId: cid, msgId: m.id.toString() } });
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { deleted: msgs.length, forAll: false };
  }

  // ---------- 转发 ----------

  async forward(userId: bigint, fromConversationId: bigint, ids: bigint[], targets: { convType?: number; targetId: string }[]) {
    if (!ids.length) throw new BadRequestException('没有选中消息');
    if (ids.length > MAX_BATCH) throw new BadRequestException(`一次最多 ${MAX_BATCH} 条`);
    if (!targets?.length) throw new BadRequestException('请选择转发对象');
    if (targets.length > MAX_FORWARD_TARGETS) throw new BadRequestException(`一次最多转发给 ${MAX_FORWARD_TARGETS} 个会话`);
    const conv = await this.ctx(userId, fromConversationId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);

    const hidden = await this.prisma.messageHide.findMany({ where: { userId, messageId: { in: ids } }, select: { messageId: true } });
    const hiddenSet = new Set(hidden.map((h) => h.messageId.toString()));
    // 已经不在群里的人：离开之后的消息看不到，也就不能转发
    const leftAt = await this.leftAtOf(userId, conv);
    const msgs = (await this.prisma.message.findMany({ where: { id: { in: ids }, conversationId: fromConversationId }, orderBy: { id: 'asc' } }))
      .filter((m) => !hiddenSet.has(m.id.toString()) && (!leftAt || m.createdAt <= leftAt));
    if (!msgs.length) throw new NotFoundException('消息不存在');
    for (const m of msgs) if (!FORWARDABLE.has(m.type)) throw new BadRequestException(m.type === 'sys' ? '这条不能转发' : '通话记录不能转发');

    const senders = await this.prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.senderId))] } }, select: { id: true, nickname: true } });
    const names = new Map(senders.map((s) => [s.id.toString(), s.nickname]));
    const items = msgs.map((m) => ({
      type: m.type,
      content: this.crypto.decrypt(key, m.cipherContent),
      // 转发的转发保留最初来源
      fwdFrom: (m.fwdFrom || names.get(m.senderId.toString()) || '').slice(0, 60),
    }));

    const results: { convType: number; targetId: string; ok: boolean; error?: string }[] = [];
    for (const t of targets) {
      // 目标可以是人（1）也可以是我在的群（2）；能不能发由 sendMessage 里的规则决定
      const convType = Number(t.convType ?? 1) === 2 ? 2 : 1;
      const targetId = String(t.targetId ?? '');
      if (![1, 2].includes(Number(t.convType ?? 1)) || !/^\d+$/.test(targetId)) {
        results.push({ convType, targetId, ok: false, error: '目标不正确' });
        continue;
      }
      try {
        for (const it of items) {
          const content = await this.copyMedia(it.type, it.content);
          await this.im.sendMessage(userId, { op: 'send', convType, targetId, msgType: it.type, content, fwdFrom: it.fwdFrom });
        }
        results.push({ convType, targetId, ok: true });
      } catch (e: any) {
        results.push({ convType, targetId, ok: false, error: e?.message ?? '发送失败' });
      }
    }
    // 发送方自己的会话列表也要刷新（sendMessage 只推给对方）
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { results };
  }

  // ---------- 表情回应 ----------

  /** 每人每条消息一个表情：点同一个取消，点别的替换 */
  async react(userId: bigint, messageId: bigint, emoji: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const conv = await this.ctx(userId, m.conversationId, true);
    if (m.type === 'sys') throw new BadRequestException('这条不能回应');
    const e = (emoji ?? '').trim();
    if (e && !MSG_REACTIONS.includes(e)) throw new BadRequestException('不支持的表情');

    const existing = await this.prisma.channelReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
    if (!e || existing?.emoji === e) {
      if (existing) await this.prisma.channelReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      await this.prisma.channelReaction.update({ where: { id: existing.id }, data: { emoji: e, createdAt: new Date() } });
    } else {
      await this.prisma.channelReaction.create({ data: { messageId, userId, emoji: e } });
    }
    const reactions = (await this.im.reactionsOf([messageId])).get(messageId.toString()) ?? [];
    const members = (await this.memberIds(conv)).filter((id) => id !== userId);
    await this.registry.deliver(members, {
      op: 'msg_reactions',
      data: { conversationId: m.conversationId.toString(), msgId: messageId.toString(), reactions },
    });
    return { msgId: messageId.toString(), reactions };
  }

  // ---------- 置顶 ----------

  /** 单聊双方都能置顶；群聊只有群主能置顶 */
  async pin(userId: bigint, messageId: bigint, pin: boolean) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const conv = await this.ctx(userId, m.conversationId, true);
    if (conv.groupId) {
      const me = await this.groups.member(conv.groupId, userId);
      if (me?.role !== 'owner') throw new ForbiddenException('只有群主可以置顶');
      if (m.type === 'sys') throw new BadRequestException('这条不能置顶');
    }

    if (pin) {
      await this.prisma.messagePin.upsert({
        where: { conversationId_messageId: { conversationId: m.conversationId, messageId } },
        create: { conversationId: m.conversationId, messageId, pinnedBy: userId },
        update: {},
      });
    } else {
      await this.prisma.messagePin.deleteMany({ where: { conversationId: m.conversationId, messageId } });
    }
    await this.registry.deliver(await this.memberIds(conv), {
      op: 'msg_pin',
      data: { conversationId: m.conversationId.toString(), msgId: messageId.toString(), pinned: pin },
    });
    return { msgId: messageId.toString(), pinned: pin };
  }

  /** 会话的置顶消息，新置顶的在前 */
  async pins(userId: bigint, conversationId: bigint) {
    const conv = await this.ctx(userId, conversationId);
    // 已经不在群里的人不给看置顶（置顶的可能是他离开以后的消息）
    if (await this.leftAtOf(userId, conv)) return [];
    const rows = await this.prisma.messagePin.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 50 });
    if (!rows.length) return [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const previews = await this.im.replyPreviewsOf(key, rows.map((r) => r.messageId));
    return rows
      .filter((r) => previews.has(r.messageId.toString()))
      .map((r) => ({ ...previews.get(r.messageId.toString())!, pinnedAt: r.createdAt }));
  }

  // ---------- 已读详情 ----------

  /** 只看自己发的消息：{read, readAt} */
  async readers(userId: bigint, messageId: bigint) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    const conv = await this.ctx(userId, m.conversationId);
    if (m.senderId !== userId) throw new ForbiddenException('只能查看自己消息的已读情况');
    // 群里不显示「已读」
    if (conv.groupId) return { read: false, readAt: null, group: true };
    return { read: m.isRead, readAt: m.readAt };
  }

  // ---------- 举报 ----------

  async report(userId: bigint, messageId: bigint, reason: string) {
    const m = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!m) throw new NotFoundException('消息不存在');
    await this.ctx(userId, m.conversationId);
    if (m.type === 'sys') throw new BadRequestException('这条不能举报');
    if (m.senderId === userId) throw new BadRequestException('不能举报自己的消息');
    const r = (reason ?? '').trim().slice(0, 500);
    if (!r) throw new BadRequestException('请选择举报原因');

    const dup = await this.prisma.report.findFirst({
      where: { reporterId: userId, targetType: 'message', targetId: messageId, status: 0 },
    });
    if (dup) return { ok: true, duplicated: true };
    await this.prisma.report.create({
      data: {
        reporterId: userId,
        targetUserId: m.senderId,
        targetType: 'message',
        targetId: messageId,
        reason: r,
        extra: JSON.stringify({ conversationId: m.conversationId.toString(), type: m.type, cipher: m.cipherContent }),
      },
    });
    return { ok: true };
  }

  // ---------- 后台：举报处理 ----------

  async adminReports(status?: number, beforeId?: bigint) {
    const rows = await this.prisma.report.findMany({
      where: { ...(status === 0 || status === 1 ? { status } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 30,
    });
    const userIds = [...new Set(rows.flatMap((r) => [r.reporterId, r.targetUserId]))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, nickname: true, avatar: true, status: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    const convIds = new Set<string>();
    const snaps = new Map<string, { conversationId: string; type: string; cipher: string }>();
    const groupSnaps = new Map<string, { groupName?: string; kind?: string }>();
    for (const r of rows) {
      if (!r.extra) continue;
      if (r.targetType === 'group') {
        try { groupSnaps.set(r.id.toString(), JSON.parse(r.extra)); } catch { /* ignore */ }
        continue;
      }
      try {
        const s = JSON.parse(r.extra);
        snaps.set(r.id.toString(), s);
        if (s.conversationId) convIds.add(String(s.conversationId));
      } catch {
        /* ignore */
      }
    }
    const convs = convIds.size
      ? await this.prisma.conversation.findMany({ where: { id: { in: [...convIds].map(BigInt) } }, select: { id: true, wrappedKey: true, type: true } })
      : [];
    const convMap = new Map(convs.map((c) => [c.id.toString(), c]));
    const alive = new Set(
      (await this.prisma.message.findMany({ where: { id: { in: rows.filter((r) => r.targetType === 'message').map((r) => r.targetId) } }, select: { id: true } })).map((m) =>
        m.id.toString(),
      ),
    );

    return rows.map((r) => {
      const s = snaps.get(r.id.toString());
      const c = s ? convMap.get(String(s.conversationId)) : undefined;
      let content = '';
      if (s && c) {
        try {
          content = this.crypto.decrypt(this.crypto.unwrapKey(c.wrappedKey), s.cipher);
        } catch {
          content = '';
        }
      }
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        status: r.status,
        result: r.result,
        createdAt: r.createdAt,
        reporter: userMap.get(r.reporterId.toString()) ?? null,
        target: userMap.get(r.targetUserId.toString()) ?? null,
        message: s ? { type: s.type, content, convType: c?.type ?? null, deleted: !alive.has(r.targetId.toString()) } : null,
        /** 举报的是整个群（targetType=group，targetId=群 id，target=群主） */
        group: r.targetType === 'group' ? { id: r.targetId, name: groupSnaps.get(r.id.toString())?.groupName ?? '', kind: groupSnaps.get(r.id.toString())?.kind ?? '' } : null,
      };
    });
  }

  /**
   * ignore=忽略；delete=删除被举报的消息；ban=删除消息并封禁发送者；close=关闭被举报的群（只对「举报这个群」有效）。
   * 同一条消息 / 同一个群的其它待处理举报一并结案
   */
  async adminHandleReport(id: bigint, action: string) {
    if (!['ignore', 'delete', 'ban', 'close'].includes(action)) throw new BadRequestException('未知操作');
    const r = await this.prisma.report.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('举报不存在');
    if (r.targetType === 'group') {
      if (action === 'delete' || action === 'ban') throw new BadRequestException('举报群只能忽略或关闭这个群');
      if (action === 'close') await this.groups.adminSetClosed(r.targetId, true);
    } else if (action === 'close') {
      throw new BadRequestException('只有举报群才能关闭群');
    }
    if (action !== 'ignore' && r.targetType === 'message') {
      const m = await this.prisma.message.findUnique({ where: { id: r.targetId } });
      if (m) {
        const conv = await this.prisma.conversation.findUnique({ where: { id: m.conversationId } });
        if (conv) await this.purge(conv, [m.id]);
      }
    }
    if (action === 'ban') await this.prisma.user.update({ where: { id: r.targetUserId }, data: { status: 1 } });
    await this.prisma.report.updateMany({
      where: { OR: [{ id }, { targetType: r.targetType, targetId: r.targetId, status: 0 }] },
      data: { status: 1, result: action },
    });
    return { ok: true };
  }

  // ---------- 工具 ----------

  /** 物理删除消息及其附属数据，并通知会话双方 */
  private async purge(conv: Conv, mids: bigint[]) {
    await this.prisma.$transaction([
      this.prisma.channelReaction.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.messagePin.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.messageHide.deleteMany({ where: { messageId: { in: mids } } }),
      this.prisma.message.deleteMany({ where: { id: { in: mids } } }),
    ]);
    const members = await this.memberIds(conv);
    const cid = conv.id.toString();
    for (const id of mids) await this.registry.deliver(members, { op: 'msg_delete', data: { conversationId: cid, msgId: id.toString() } });
    await this.registry.deliver(members, { op: 'conv_refresh' });
  }

  /** 取会话并校验本人在会话里。write=true：群聊还要现在在群里、群是正常的（单聊不受影响） */
  private async ctx(userId: bigint, conversationId: bigint, write = false): Promise<Conv> {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.im.assertMember(userId, conv, write);
    return conv;
  }

  /** 会话里现在的人：单聊是两个人，群聊是还在群里的成员 */
  private async memberIds(conv: Conv): Promise<bigint[]> {
    if (conv.groupId) return this.groups.activeIds(conv.groupId);
    return [conv.userAId, conv.userBId].filter((id): id is bigint => id != null);
  }

  /** 群聊里我已经不在群里了 → 我离开的时间（这之后的消息我看不到）；其余情况是 null */
  private async leftAtOf(userId: bigint, conv: Conv): Promise<Date | null> {
    if (!conv.groupId) return null;
    const m = await this.groups.member(conv.groupId, userId);
    return m && m.status !== 0 ? m.leftAt ?? new Date(0) : null;
  }
}
