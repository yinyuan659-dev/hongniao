import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { NeedProfileException, profileDone } from '../common/need-profile';
import { assertCanChat } from '../common/chat-gate';
import { assertKyc } from '../common/kyc-gate';
import { ConnectionRegistry } from './connection.registry';
import { IntimacyService } from '../intimacy/intimacy.service';
import { MessagePayload, ReactionView, ReplyPreview, SendFrame } from './im.types';
import { resolveInviteUser } from '../invite/invite.service';
import { FILE_MAX_SIZE } from '../upload/upload.service';

/** 客户端能发的消息类型（通话记录只由服务端写入） */
const SEND_TYPES = new Set(['text', 'image', 'video', 'audio', 'file', 'location']);

const CHAT_FILE_RE = /^\/res\/[\w.-]+\/file\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

/**
 * 文件消息（msgType file）：{ url, name, size, mime }，url 只认 POST /upload/file 存进来的地址，
 * 不能借文件消息发外链；文件名 / 大小 / 类型是客户端带的，只做清洗。
 */
export function sanitizeFile(content: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(content);
  } catch {
    throw new BadRequestException('文件内容不对');
  }
  const url = String(o.url ?? '');
  if (!CHAT_FILE_RE.test(url)) throw new BadRequestException('文件地址不对');
  const size = Number(o.size);
  const mime = String(o.mime ?? '');
  return JSON.stringify({
    url,
    name: String(o.name ?? '').replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 255) || 'file',
    size: Number.isInteger(size) && size > 0 && size <= FILE_MAX_SIZE ? size : 0,
    mime: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime.slice(0, 120) : 'application/octet-stream',
  });
}

@Injectable()
export class ImService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
    private readonly intimacy: IntimacyService,
  ) {}

  // ---------- 发送 ----------

  async sendMessage(senderId: bigint, frame: SendFrame): Promise<MessagePayload> {
    if (Number(frame.convType) !== 1) throw new BadRequestException('参数不正确');
    if (!SEND_TYPES.has(frame.msgType)) throw new BadRequestException('这种消息不能直接发送');
    const sender = await this.prisma.user.findUnique({ where: { id: senderId } });
    if (!sender || sender.status !== 0) throw new ForbiddenException('账号异常');
    if (frame.msgType === 'file') frame = { ...frame, content: sanitizeFile(frame.content) };

    return this.sendSingle(sender, BigInt(frame.targetId), frame);
  }

  private async sendSingle(sender: any, peerId: bigint, frame: SendFrame): Promise<MessagePayload> {
    if (peerId === sender.id) throw new BadRequestException('不能给自己发消息');
    const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
    if (!peer || peer.status !== 0) throw new NotFoundException('对方不存在');
    // 互相喜欢后才能聊天（规则上线前就聊过的有保留期），见 common/chat-gate.ts。
    // 转发也是走这里发出去的，所以同样受限制。扫邀请名片只能打开聊天页，发不出消息。
    await assertCanChat(this.prisma, sender.id, peerId);
    // 做过实人认证才能聊天（后台开关控制，默认关），见 common/kyc-gate.ts
    await assertKyc(this.prisma, sender.id);

    const conv = await this.getOrCreateSingleConversation(sender.id, peerId);
    // 没完成资料收集的人不能主动发起聊天；对方先发过消息的，可以回复
    if (!(await profileDone(this.prisma, sender.id))) {
      const fromPeer = await this.prisma.message.findFirst({
        where: { conversationId: conv.id, senderId: peerId },
        select: { id: true },
      });
      if (!fromPeer) throw new NeedProfileException();
    }
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const reply = await this.resolveReply(conv.id, key, frame.replyToId);

    // 聊天不收费（相亲全程 0 收费，开发文档 §1）
    const msg = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          conversationId: conv.id,
          senderId: sender.id,
          receiverId: peerId,
          type: frame.msgType,
          cipherContent: this.crypto.encrypt(key, frame.content),
          replyToId: reply ? BigInt(reply.id) : null,
          fwdFrom: frame.fwdFrom || null,
        },
      });
      await tx.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: created.createdAt } });
      return created;
    });

    const payload = this.toPayload(msg, conv, sender, frame.content, reply);
    await this.registry.deliver([peerId], { op: 'msg', data: payload });
    // 亲密度：发送方 +1，接收方 +0.5（异步不阻塞发送）
    void this.intimacy.bump(sender.id, peerId);
    return payload;
  }

  /** 通话记录消息（微信式）：写入单聊会话并推送双方 */
  async sendCallMessage(callerId: bigint, calleeId: bigint, content: string) {
    const sender = await this.prisma.user.findUnique({ where: { id: callerId } });
    if (!sender) return;
    const conv = await this.getOrCreateSingleConversation(callerId, calleeId);
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const msg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        senderId: callerId,
        receiverId: calleeId,
        type: 'call',
        cipherContent: this.crypto.encrypt(key, content),
      },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });
    const payload = this.toPayload(msg, conv, sender, content);
    await this.registry.deliver([callerId, calleeId], { op: 'msg', data: payload });
  }

  /** 扫邀请名片（内容 SITE_BASE/t/?u=短号）：直接打开与名片主人的单聊，不需要对方同意 */
  async openByInviteCode(userId: bigint, code: string) {
    const peer = await resolveInviteUser(this.prisma, code);
    if (!peer || peer.status !== 0) throw new NotFoundException('名片已失效');
    if (peer.id === userId) throw new BadRequestException('这是你自己的名片');
    const conv = await this.getOrCreateSingleConversation(userId, peer.id);
    return { conversationId: conv.id, peer: { id: peer.id, nickname: peer.nickname, avatar: peer.avatar } };
  }

  async getOrCreateSingleConversation(a: bigint, b: bigint) {
    const [min, max] = a < b ? [a, b] : [b, a];
    const pairKey = `${min}_${max}`;
    const existing = await this.prisma.conversation.findUnique({ where: { pairKey } });
    if (existing) return existing;
    return this.prisma.conversation.create({
      data: {
        type: 1,
        pairKey,
        userAId: min,
        userBId: max,
        wrappedKey: this.crypto.wrapKey(this.crypto.generateConversationKey()),
      },
    });
  }

  // ---------- 已读 ----------

  async markRead(userId: bigint, conversationId: bigint, msgId: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return;
    if (conv.userAId !== userId && conv.userBId !== userId) return;
    await this.prisma.message.updateMany({
      where: { conversationId, receiverId: userId, isRead: false, id: { lte: msgId } },
      data: { isRead: true, readAt: new Date() },
    });
    const peer = conv.userAId === userId ? conv.userBId : conv.userAId;
    await this.registry.deliver([peer!], {
      op: 'read',
      conversationId: conversationId.toString(),
      msgId: msgId.toString(),
      userId: userId.toString(),
    });
  }

  // ---------- 查询（REST） ----------

  async listConversations(userId: bigint) {
    const convs = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      orderBy: { lastMsgAt: 'desc' },
      take: 100,
    });

    // 「只删自己这边」的消息不当会话预览
    const hiddenRows = await this.prisma.messageHide.findMany({ where: { userId }, select: { messageId: true }, orderBy: { createdAt: 'desc' }, take: 2000 });
    const hidden = new Set(hiddenRows.map((h) => h.messageId.toString()));

    // 我和每个聊天对象的喜欢关系：决定这个聊天要不要出现在列表里
    const peerIds = convs.map((c) => (c.userAId === userId ? c.userBId! : c.userAId!));
    const actions = peerIds.length
      ? await this.prisma.matchAction.findMany({
          where: { OR: [{ userId, targetId: { in: peerIds } }, { targetId: userId, userId: { in: peerIds } }] },
          select: { userId: true, targetId: true, kind: true, matchedAt: true },
        })
      : [];
    const mine = new Map(actions.filter((a) => a.userId === userId).map((a) => [a.targetId.toString(), a]));
    const theirs = new Map(actions.filter((a) => a.userId !== userId).map((a) => [a.userId.toString(), a]));

    const result = [] as any[];
    for (const conv of convs) {
      const pid = (conv.userAId === userId ? conv.userBId! : conv.userAId!).toString();
      // 我点过「不合适，不再联系」的：从列表里收起
      if (mine.get(pid)?.kind === 'end') continue;
      const mutual = mine.get(pid)?.kind === 'like' && theirs.get(pid)?.kind === 'like';
      const key = this.crypto.unwrapKey(conv.wrappedKey);
      const recent = await this.prisma.message.findMany({
        where: { conversationId: conv.id },
        orderBy: { id: 'desc' },
        take: hidden.size ? 10 : 1,
      });
      const lastMsg = recent.find((m) => !hidden.has(m.id.toString())) ?? null;
      // 没互相喜欢、也没聊过的空聊天（只是点开过聊天页）不显示。聊过的老聊天一直显示，记录还能看
      if (!mutual && recent.length === 0) continue;

      const peerId = conv.userAId === userId ? conv.userBId! : conv.userAId!;
      const peer = await this.prisma.user.findUnique({ where: { id: peerId } });
      const unread = await this.prisma.message.count({
        where: { conversationId: conv.id, receiverId: userId, isRead: false },
      });
      result.push({
        id: conv.id,
        type: 1,
        peer: peer && { id: peer.id, nickname: peer.nickname, avatar: peer.avatar, gender: peer.gender },
        lastMsg: lastMsg && this.preview(lastMsg, key),
        unread,
        lastMsgAt: conv.lastMsgAt,
        /** 互相喜欢的才有：at 哪天配上的；fresh = 刚配上还没说过话（列表里带「刚配上」） */
        match: mutual ? { at: mine.get(pid)?.matchedAt ?? null, fresh: recent.length === 0 } : null,
        /** 对方点了「不合适，不再联系」 */
        ended: theirs.get(pid)?.kind === 'end',
      });
    }
    return result;
  }

  /**
   * 消息页搜索：
   * messages = 我所在会话里文字消息的内容匹配（密文只能逐条解密后比对，只扫最近 SEARCH_SCAN 条）；
   * users = 按 6 位 ID（不限性别）/ 昵称（仅异性）找用户，客户端点了直接开私聊。
   * 会话名匹配由客户端在本地会话列表里做。
   */
  async search(userId: bigint, raw: string) {
    const q = (raw ?? '').trim().slice(0, 50);
    if (!q) return { messages: [], users: [] };
    const needle = q.toLowerCase();
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { gender: true } });
    if (!me) return { messages: [], users: [] };

    const convs = await this.prisma.conversation.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      select: { id: true, type: true, userAId: true, userBId: true, wrappedKey: true },
    });
    const convMap = new Map(convs.map((c) => [c.id.toString(), c]));

    const SEARCH_SCAN = 5000;
    const MAX_HITS = 60;
    const rows = convMap.size
      ? await this.prisma.message.findMany({
          where: { conversationId: { in: [...convMap.values()].map((c) => c.id) }, type: 'text' },
          orderBy: { id: 'desc' },
          take: SEARCH_SCAN,
          select: { id: true, conversationId: true, senderId: true, cipherContent: true, createdAt: true },
        })
      : [];
    const keys = new Map<string, Buffer>();
    const hits: { row: (typeof rows)[number]; content: string; idx: number }[] = [];
    for (const row of rows) {
      const cid = row.conversationId.toString();
      let key = keys.get(cid);
      if (!key) {
        key = this.crypto.unwrapKey(convMap.get(cid)!.wrappedKey);
        keys.set(cid, key);
      }
      let content: string;
      try {
        content = this.crypto.decrypt(key, row.cipherContent);
      } catch {
        continue;
      }
      const idx = content.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      hits.push({ row, content, idx });
      if (hits.length >= MAX_HITS) break;
    }

    // 发送者 + 单聊对方一次查完
    const userIds = new Set<string>();
    for (const h of hits) {
      userIds.add(h.row.senderId.toString());
      const c = convMap.get(h.row.conversationId.toString())!;
      userIds.add((c.userAId === userId ? c.userBId! : c.userAId!).toString());
    }
    const people = userIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...userIds].map(BigInt) } },
          select: { id: true, nickname: true, avatar: true },
        })
      : [];
    const personMap = new Map(people.map((p) => [p.id.toString(), p]));

    const messages = hits.map(({ row, content, idx }) => {
      const c = convMap.get(row.conversationId.toString())!;
      const targetId = (c.userAId === userId ? c.userBId! : c.userAId!).toString();
      const peer = personMap.get(targetId);
      const title = peer?.nickname ?? '';
      const avatar = peer?.avatar ?? '';
      const start = Math.max(0, idx - 16);
      const snippet = (start > 0 ? '…' : '') + content.slice(start, start + 120).replace(/\s+/g, ' ');
      const sender = personMap.get(row.senderId.toString());
      return {
        id: row.id.toString(),
        conversationId: c.id.toString(),
        convType: c.type,
        targetId,
        title,
        avatar,
        senderId: row.senderId.toString(),
        senderNickname: row.senderId === userId ? '我' : sender?.nickname ?? '',
        content: snippet,
        createdAt: row.createdAt,
      };
    });

    // 6 位 ID 精确匹配不限性别（知道 ID 等同拿到名片）；昵称模糊匹配只找异性
    const users = await this.prisma.user.findMany({
      where: {
        status: 0,
        hidden: false,
        id: { not: userId },
        OR: [{ shortId: q }, { nickname: { contains: q }, gender: me.gender === 1 ? 2 : 1 }],
      },
      orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, nickname: true, avatar: true, gender: true, age: true, cityName: true },
    });

    return { messages, users };
  }

  /** 清空聊天记录：双向物理删除全部消息，并实时推送双方在线端同步清空 */
  async clearMessages(userId: bigint, conversationId: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(userId, conv);

    await this.prisma.messagePin.deleteMany({ where: { conversationId } });
    await this.prisma.messageHide.deleteMany({ where: { conversationId } });
    await this.prisma.message.deleteMany({ where: { conversationId } });
    const peers = [conv.userAId, conv.userBId].filter((id): id is bigint => id != null);
    await this.registry.deliver(peers, { op: 'conv_cleared', data: { conversationId: conversationId.toString() } });
    return { ok: true };
  }

  /**
   * 默认返回最新 limit 条；带 aroundId（搜索结果定位）时返回「目标往前 20 条 → 最新」的连续一段，
   * 客户端仍按「列表末尾即最新」追加实时消息。往后最多 1000 条，超出部分不返回。
   */
  async listMessages(userId: bigint, conversationId: bigint, beforeId?: bigint, limit = 30, aroundId?: bigint) {
    const conv = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw new NotFoundException('会话不存在');
    await this.assertMember(userId, conv);

    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const hiddenRows = await this.prisma.messageHide.findMany({ where: { userId, conversationId }, select: { messageId: true } });
    const notHidden = hiddenRows.length ? { id: { notIn: hiddenRows.map((h) => h.messageId) } } : {};
    let messages;
    if (aroundId) {
      const [older, newer] = await Promise.all([
        this.prisma.message.findMany({
          where: { conversationId, AND: [{ id: { lt: aroundId } }, notHidden] },
          orderBy: { id: 'desc' },
          take: 20,
        }),
        this.prisma.message.findMany({
          where: { conversationId, AND: [{ id: { gte: aroundId } }, notHidden] },
          orderBy: { id: 'asc' },
          take: 1000,
        }),
      ]);
      messages = [...newer.reverse(), ...older];
    } else {
      messages = await this.prisma.message.findMany({
        where: { conversationId, AND: [beforeId ? { id: { lt: beforeId } } : {}, notHidden] },
        orderBy: { id: 'desc' },
        take: Math.min(limit, 50),
      });
    }

    const senderIds = [...new Set(messages.map((m) => m.senderId.toString()))];
    const senders = await this.prisma.user.findMany({ where: { id: { in: senderIds.map(BigInt) } } });
    const senderMap = new Map(senders.map((s) => [s.id.toString(), s]));
    const ids = messages.map((m) => m.id);
    const [replies, reactions] = await Promise.all([
      this.replyPreviewsOf(key, messages.map((m) => m.replyToId).filter((x): x is bigint => x != null)),
      this.reactionsOf(ids),
    ]);

    return messages.reverse().map((m) => {
      const sender = senderMap.get(m.senderId.toString());
      return {
        id: m.id,
        conversationId: m.conversationId,
        senderId: m.senderId,
        senderNickname: sender?.nickname ?? '',
        senderAvatar: sender?.avatar ?? '',
        receiverId: m.receiverId,
        type: m.type,
        content: this.crypto.decrypt(key, m.cipherContent),
        isRead: m.isRead,
        readAt: m.readAt,
        createdAt: m.createdAt,
        replyTo: m.replyToId ? replies.get(m.replyToId.toString()) ?? { id: m.replyToId.toString(), senderId: '', senderNickname: '', type: '', content: '', deleted: true } : null,
        fwdFrom: m.fwdFrom,
        reactions: reactions.get(m.id.toString()) ?? [],
      };
    });
  }

  /** 发送时校验 replyToId 属于同一会话，返回引用预览；不合法就当没回复 */
  async resolveReply(conversationId: bigint, key: Buffer, replyToId?: string): Promise<ReplyPreview | null> {
    if (!replyToId || !/^\d+$/.test(replyToId)) return null;
    const m = await this.prisma.message.findUnique({ where: { id: BigInt(replyToId) } });
    if (!m || m.conversationId !== conversationId) return null;
    return (await this.replyPreviewsOf(key, [m.id])).get(m.id.toString()) ?? null;
  }

  async replyPreviewsOf(key: Buffer, ids: bigint[]) {
    const map = new Map<string, ReplyPreview>();
    if (!ids.length) return map;
    const rows = await this.prisma.message.findMany({ where: { id: { in: [...new Set(ids)] } } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.senderId))] } },
      select: { id: true, nickname: true },
    });
    const names = new Map(users.map((u) => [u.id.toString(), u.nickname]));
    for (const r of rows) {
      let content = '';
      try {
        const plain = this.crypto.decrypt(key, r.cipherContent);
        if (r.type === 'text') content = plain.slice(0, 100);
        else if (r.type === 'image') content = plain;
      } catch {
        /* ignore */
      }
      map.set(r.id.toString(), {
        id: r.id.toString(),
        senderId: r.senderId.toString(),
        senderNickname: names.get(r.senderId.toString()) ?? '',
        type: r.type,
        content,
      });
    }
    return map;
  }

  /** messageId → [{emoji,count,userIds}]，按数量降序 */
  async reactionsOf(ids: bigint[]) {
    const map = new Map<string, ReactionView[]>();
    if (!ids.length) return map;
    const rows = await this.prisma.channelReaction.findMany({
      where: { messageId: { in: ids } },
      orderBy: { createdAt: 'asc' },
      select: { messageId: true, userId: true, emoji: true },
    });
    const byMsg = new Map<string, Map<string, string[]>>();
    for (const r of rows) {
      const k = r.messageId.toString();
      if (!byMsg.has(k)) byMsg.set(k, new Map());
      const e = byMsg.get(k)!;
      if (!e.has(r.emoji)) e.set(r.emoji, []);
      e.get(r.emoji)!.push(r.userId.toString());
    }
    for (const [k, e] of byMsg) {
      map.set(
        k,
        [...e.entries()]
          .map(([emoji, users]) => ({ emoji, count: users.length, userIds: users.slice(0, 20) }))
          .sort((a, b) => b.count - a.count),
      );
    }
    return map;
  }

  async assertMember(userId: bigint, conv: { userAId: bigint | null; userBId: bigint | null }) {
    if (conv.userAId !== userId && conv.userBId !== userId) throw new ForbiddenException('无权访问该会话');
  }

  private preview(msg: any, key: Buffer) {
    let content: string;
    try {
      content = this.crypto.decrypt(key, msg.cipherContent);
    } catch {
      content = '';
    }
    return { id: msg.id, senderId: msg.senderId, type: msg.type, content, createdAt: msg.createdAt };
  }

  private toPayload(msg: any, conv: any, sender: any, plainContent: string, reply?: ReplyPreview | null): MessagePayload {
    return {
      ...(reply ? { replyTo: reply } : {}),
      ...(msg.fwdFrom ? { fwdFrom: msg.fwdFrom } : {}),
      id: msg.id.toString(),
      conversationId: conv.id.toString(),
      convType: conv.type,
      senderId: sender.id.toString(),
      senderNickname: sender.nickname,
      senderAvatar: sender.avatar,
      receiverId: msg.receiverId?.toString() ?? null,
      type: msg.type,
      content: plainContent,
      createdAt: msg.createdAt.toISOString(),
    };
  }
}
