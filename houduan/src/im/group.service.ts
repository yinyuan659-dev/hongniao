import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ConnectionRegistry } from './connection.registry';
import { MessagePayload } from './im.types';

/**
 * 群聊（用户 2026-11-27 定的，样稿 design/12-group.html）。照原项目的群搬回来，按相亲 App 收紧了：
 *   1. 只有两种群：旅行线路的群（领队是群主）、相亲活动的群（发起人是群主），都由系统建（createSystemGroup）。
 *      用户不能自己建群；没有群广场、邀请码、入群密码、扫码进群。
 *   2. 进群只有一条路：线路页点「约单」、活动页点「参与」，由那两个模块调 systemJoin。群主不能拉人。
 *   3. 只有群主和成员两种人。群主能改群名、写公告、移出成员、解散；不能退群、不能转让。
 *   4. 退群、被移出都不删成员行，只改 status：之前的聊天记录还能看；被移出的人不能自己再进。
 *   5. 到 expireAt 那一刻自动解散（到点触发的定时器，不是隔一会儿扫一遍库，见 timers）；
 *      解散、被平台关闭以后不能再发消息，群留在消息列表里，可以自己删掉（hidden）。
 *   6. 所有变化都用 WebSocket 推给相关的人（op: 'group'，带最新的群信息），客户端不用轮询。
 *
 * 这个服务不依赖 ImService（ImService、MessageService 反过来用它），免得绕圈引用。
 */

/** 我和这个群现在是什么关系：ok 正常 | left 我退出了 | kicked 我被移出了 | dissolved 群解散了 | closed 群被平台关闭 */
export type GroupState = 'ok' | 'left' | 'kicked' | 'dissolved' | 'closed';

/** 客户端按这个 reason 把输入框换成一句话（WebSocket 的 error 帧 code、HTTP 的 reason 都带） */
export const GROUP_REASON: Record<Exclude<GroupState, 'ok'>, string> = {
  left: 'group_left',
  kicked: 'group_left',
  dissolved: 'group_dissolved',
  closed: 'group_closed',
};
const GROUP_MSG: Record<Exclude<GroupState, 'ok'>, string> = {
  left: '你已不在这个群里',
  kicked: '你已不在这个群里',
  dissolved: '这个群已解散',
  closed: '这个群因违规已被平台关闭',
};

/** 群用不了：HTTP 403，带 reason */
export class GroupGateException extends HttpException {
  readonly code: string;
  constructor(state: Exclude<GroupState, 'ok'>) {
    super({ message: GROUP_MSG[state], reason: GROUP_REASON[state] }, 403);
    this.code = GROUP_REASON[state];
  }
}

export const GROUP_KINDS = ['trip', 'event', 'test'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

/** 群名最长、公告最长 */
const NAME_MAX = 30;
const NOTICE_MAX = 500;
/** 线路群人数上限（约单不等于付钱，会比名额多）；活动群由活动模块按名额传进来 */
export const GROUP_LIMIT_DEFAULT = 200;

type GroupRow = {
  id: bigint; name: string; avatar: string; notice: string; ownerId: bigint; memberLimit: number;
  kind: string; refId: bigint; status: number; endAt: Date | null; expireAt: Date | null;
};
type MemberRow = { groupId: bigint; userId: bigint; role: string; status: number; lastReadMsgId: bigint; muted: boolean; hidden: boolean; joinedAt: Date; leftAt: Date | null };

export function groupStateOf(group: { status: number }, member?: { status: number } | null): GroupState {
  if (member && member.status === 1) return 'left';
  if (member && member.status >= 2) return 'kicked';
  if (group.status === 1) return 'dissolved';
  if (group.status === 2) return 'closed';
  return 'ok';
}

/** setTimeout 最长只能定 2^31-1 毫秒（约 24.8 天），更久的先定到这么久，到了再接着定 */
const TIMER_MAX_MS = 2_147_000_000;

@Injectable()
export class GroupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Group');
  /**
   * 到期解散是「到点触发」的，不是隔一会儿扫一遍库（用户 2026-11-27 要求）：
   * 每个有到期时间的群在内存里挂一个定时器，正好到 expireAt 那一刻响；建群、改到期时间、恢复被关闭的群时重新挂，解散 / 关闭时摘掉。
   * 服务重启后在 onModuleInit 里按库里的 expireAt 重新挂一遍（重启期间已经过期的马上解散）。
   * 另外有人碰到一个已经过期但还没解散的群时（access），当场解散，算是兜底。
   */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectionRegistry,
  ) {}

  async onModuleInit() {
    try {
      const rows = await this.prisma.chatGroup.findMany({ where: { status: 0, expireAt: { not: null } }, select: { id: true, expireAt: true } });
      for (const g of rows) this.arm(g.id, g.expireAt);
      if (rows.length) this.logger.log(`重新挂上 ${rows.length} 个群的到期定时器`);
    } catch (e) {
      this.logger.warn(`挂到期定时器出错: ${e}`);
    }
  }

  onModuleDestroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** 给一个群挂上（或者摘掉）到期定时器。expireAt 为空 = 不会自动解散 */
  private arm(groupId: bigint, expireAt: Date | null) {
    const key = groupId.toString();
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    this.timers.delete(key);
    if (!expireAt) return;
    const delay = Math.min(Math.max(expireAt.getTime() - Date.now(), 0), TIMER_MAX_MS);
    const t = setTimeout(() => void this.onTimer(groupId).catch((e) => this.logger.warn(`到期解散出错 ${groupId}: ${e}`)), delay);
    // 不要因为有定时器挂着就拦住进程退出
    t.unref?.();
    this.timers.set(key, t);
  }

  /** 定时器响了：再看一眼库（到期时间可能改过、群可能已经解散了），真到期了才解散，没到就接着定 */
  private async onTimer(groupId: bigint) {
    this.timers.delete(groupId.toString());
    const g = await this.prisma.chatGroup.findUnique({ where: { id: groupId }, select: { id: true, status: true, expireAt: true } });
    if (!g || g.status !== 0 || !g.expireAt) return;
    if (g.expireAt.getTime() > Date.now()) return this.arm(g.id, g.expireAt);
    await this.systemDissolve(groupId, 'expire');
  }

  /** 改活动 / 行程的时间（第 2、3 步用）：到期定时器跟着重新挂，群里的人收到推送 */
  async setSchedule(groupId: bigint, endAt: Date | null, expireAt: Date | null) {
    const group = await this.mustGroup(groupId);
    await this.prisma.chatGroup.update({ where: { id: groupId }, data: { endAt, expireAt } });
    if (group.status === 0) {
      this.arm(groupId, expireAt);
      await this.push(await this.activeIds(groupId), 'info', groupId);
    }
    return { ok: true };
  }

  // ---------- 给别的模块用（线路、活动、后台） ----------

  /** 系统建群：线路审核通过 / 活动发布时调用。群主自动进群 */
  async createSystemGroup(opts: {
    ownerId: bigint; name: string; kind: GroupKind; refId?: bigint; avatar?: string; notice?: string;
    memberLimit?: number; endAt?: Date | null; expireAt?: Date | null;
  }) {
    const name = cleanName(opts.name);
    if (!name) throw new BadRequestException('群名不能为空');
    if (!GROUP_KINDS.includes(opts.kind)) throw new BadRequestException('群的类型不对');
    const owner = await this.prisma.user.findUnique({ where: { id: opts.ownerId }, select: { id: true, status: true } });
    if (!owner || owner.status !== 0) throw new NotFoundException('群主不存在');
    const limit = Math.min(Math.max(Math.floor(opts.memberLimit ?? GROUP_LIMIT_DEFAULT) || GROUP_LIMIT_DEFAULT, 2), 500);

    const group = await this.prisma.$transaction(async (tx) => {
      const g = await tx.chatGroup.create({
        data: {
          name, ownerId: opts.ownerId, kind: opts.kind, refId: opts.refId ?? 0n,
          avatar: (opts.avatar ?? '').slice(0, 255), notice: (opts.notice ?? '').slice(0, NOTICE_MAX),
          memberLimit: limit, endAt: opts.endAt ?? null, expireAt: opts.expireAt ?? null,
        },
      });
      await tx.conversation.create({
        data: { type: 2, pairKey: `g_${g.id}`, groupId: g.id, wrappedKey: this.crypto.wrapKey(this.crypto.generateConversationKey()) },
      });
      await tx.groupMember.create({ data: { groupId: g.id, userId: opts.ownerId, role: 'owner' } });
      return g;
    });
    this.arm(group.id, group.expireAt);
    await this.sysMessage(group, opts.ownerId, 'create', '群聊已建好');
    await this.push([opts.ownerId], 'create', group.id);
    return this.view(opts.ownerId, group.id);
  }

  /**
   * 系统拉人进群：线路页「约单」、活动页「参与」成功后调用（用户自己点的，不是别人拉的）。
   * 已经在群里 → 原样返回；自己退出过 → 重新进来；被移出过 → 不让进；群满了 / 解散了 → 不让进。
   */
  async systemJoin(userId: bigint, groupId: bigint) {
    const group = await this.mustGroup(groupId);
    if (group.status !== 0) throw new GroupGateException(group.status === 2 ? 'closed' : 'dissolved');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, nickname: true, status: true } });
    if (!user || user.status !== 0) throw new ForbiddenException('账号异常');

    const existing = await this.member(groupId, userId);
    if (existing?.status === 0) return this.view(userId, groupId);
    if (existing && existing.status >= 2) throw new ForbiddenException('你已被移出这个群，不能再加入');
    const count = await this.prisma.groupMember.count({ where: { groupId, status: 0 } });
    if (count >= group.memberLimit) throw new BadRequestException('这个群已经满了');

    if (existing) {
      // 自己退出过又回来：退出期间的消息不算未读
      const last = await this.lastMsgId(groupId);
      await this.prisma.groupMember.update({
        where: { groupId_userId: { groupId, userId } },
        data: { status: 0, leftAt: null, hidden: false, lastReadMsgId: last, joinedAt: new Date() },
      });
    } else {
      await this.prisma.groupMember.create({ data: { groupId, userId } });
    }
    await this.sysMessage(group, userId, 'join', `${user.nickname} 加入了群聊`);
    await this.push(await this.activeIds(groupId), 'join', groupId, { userId: userId.toString(), nickname: user.nickname });
    return this.view(userId, groupId);
  }

  /** 系统解散：到期（expire）、活动取消 / 线路下架（cancel） */
  async systemDissolve(groupId: bigint, why: 'expire' | 'cancel') {
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group || group.status !== 0) return { ok: true };
    return this.doDissolve(group, group.ownerId, why === 'expire' ? '群聊已到期，自动解散' : '活动已取消，群聊已解散');
  }

  /** 群里现在的成员 id（只算在群里的） */
  async activeIds(groupId: bigint): Promise<bigint[]> {
    const rows = await this.prisma.groupMember.findMany({ where: { groupId, status: 0 }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  member(groupId: bigint, userId: bigint): Promise<MemberRow | null> {
    return this.prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
  }

  /**
   * 取群和我的成员行，并检查我能不能进这个会话：
   *   write=false（看消息）：只要进过群就行，退了、被移出了也能看之前的记录；
   *   write=true（发消息、表情、置顶、转发出去）：必须还在群里，而且群是正常的。
   */
  async access(userId: bigint, groupId: bigint, write: boolean) {
    let group = await this.mustGroup(groupId);
    // 兜底：已经过了到期时间但还没解散（比如定时器挂在别的节点上、那个节点刚好挂了），碰到的这一刻当场解散
    if (group.status === 0 && group.expireAt && group.expireAt.getTime() <= Date.now()) {
      await this.systemDissolve(groupId, 'expire');
      group = await this.mustGroup(groupId);
    }
    const member = await this.member(groupId, userId);
    if (!member) throw new ForbiddenException('无权访问该会话');
    const state = groupStateOf(group, member);
    if (write && state !== 'ok') throw new GroupGateException(state);
    return { group, member, state };
  }

  // ---------- 用户操作 ----------

  /** 群资料。进过这个群的人才能看；已经不在群里的人看不到成员名单 */
  async view(userId: bigint, groupId: bigint) {
    const { group, member, state } = await this.access(userId, groupId, false);
    const inGroup = member.status === 0;
    const rows = inGroup
      ? await this.prisma.groupMember.findMany({ where: { groupId, status: 0 }, orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }] })
      : [];
    const users = rows.length
      ? await this.prisma.user.findMany({ where: { id: { in: rows.map((m) => m.userId) } }, select: { id: true, nickname: true, avatar: true, gender: true } })
      : [];
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    // 群主排第一个，其余按进群先后
    const members = rows
      .map((m) => ({ ...(userMap.get(m.userId.toString()) ?? { id: m.userId, nickname: '', avatar: '', gender: 0 }), role: m.role, joinedAt: m.joinedAt }))
      .sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1));
    return {
      ...(await this.summary(group)),
      /** 我和这个群的关系：ok / left / kicked / dissolved / closed */
      state,
      role: member.role,
      muted: member.muted,
      members,
    };
  }

  /** 退出群聊：群主不能退（群跟着线路 / 活动走，不办了就解散） */
  async leave(userId: bigint, groupId: bigint) {
    const { group, member } = await this.access(userId, groupId, false);
    if (member.status !== 0) return { ok: true };
    if (member.role === 'owner') throw new BadRequestException('群主不能退出群聊，可以解散');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } });
    // 先写「退出了」那行小字，再改状态：这一行本人也看得到
    if (group.status === 0) await this.sysMessage(group, userId, 'leave', `${user?.nickname ?? ''} 退出了群聊`);
    await this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { status: 1, leftAt: new Date() } });
    await this.push([...(await this.activeIds(groupId)), userId], 'leave', groupId, { userId: userId.toString(), nickname: user?.nickname ?? '' });
    return { ok: true };
  }

  /** 群主移出成员：被移出的人不能自己再进 */
  async kick(operatorId: bigint, groupId: bigint, targetId: bigint) {
    const { group, member } = await this.access(operatorId, groupId, true);
    if (member.role !== 'owner') throw new ForbiddenException('只有群主可以移出成员');
    if (targetId === operatorId) throw new BadRequestException('不能移出自己');
    return this.remove(group, targetId, operatorId, 2);
  }

  /** 群主解散 */
  async dissolve(ownerId: bigint, groupId: bigint) {
    const { group, member } = await this.access(ownerId, groupId, false);
    if (member.role !== 'owner') throw new ForbiddenException('只有群主可以解散群聊');
    if (group.status !== 0) return { ok: true };
    return this.doDissolve(group, ownerId, '群主解散了群聊');
  }

  /** 群主改群名 / 写公告（只传要改的那项） */
  async update(operatorId: bigint, groupId: bigint, patch: { name?: unknown; notice?: unknown }) {
    const { group, member } = await this.access(operatorId, groupId, true);
    if (member.role !== 'owner') throw new ForbiddenException('只有群主可以修改');
    const data: { name?: string; notice?: string } = {};
    if (patch.name !== undefined && patch.name !== null) {
      const name = cleanName(String(patch.name));
      if (!name) throw new BadRequestException('群名不能为空');
      if (name !== group.name) data.name = name;
    }
    if (patch.notice !== undefined && patch.notice !== null) {
      const notice = String(patch.notice).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
      if (notice.length > NOTICE_MAX) throw new BadRequestException(`群公告最多 ${NOTICE_MAX} 个字`);
      if (notice !== group.notice) data.notice = notice;
    }
    if (data.name === undefined && data.notice === undefined) return this.view(operatorId, groupId);
    const next = await this.prisma.chatGroup.update({ where: { id: groupId }, data });
    if (data.name !== undefined) await this.sysMessage(next, operatorId, 'rename', `群主把群名改成了「${data.name}」`);
    if (data.notice !== undefined) await this.sysMessage(next, operatorId, 'notice', data.notice ? '群主更新了群公告' : '群主清空了群公告');
    await this.push(await this.activeIds(groupId), 'info', groupId);
    return this.view(operatorId, groupId);
  }

  /** 消息免打扰：只影响自己 */
  async setMuted(userId: bigint, groupId: bigint, muted: boolean) {
    await this.access(userId, groupId, false);
    await this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { muted } });
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { ok: true, muted };
  }

  /** 从自己的消息列表里删掉：只有已经解散 / 被关闭 / 自己已经不在的群才能删 */
  async hide(userId: bigint, groupId: bigint) {
    const { state } = await this.access(userId, groupId, false);
    if (state === 'ok') throw new BadRequestException('还在群里的群不能删，先退出群聊');
    await this.prisma.groupMember.update({ where: { groupId_userId: { groupId, userId } }, data: { hidden: true } });
    await this.registry.deliver([userId], { op: 'conv_refresh' });
    return { ok: true };
  }

  /** 举报这个群（进过群的人才能举报） */
  async report(userId: bigint, groupId: bigint, reason: string) {
    const { group } = await this.access(userId, groupId, false);
    const r = (reason ?? '').trim().slice(0, 500);
    if (!r) throw new BadRequestException('请选择举报原因');
    const dup = await this.prisma.report.findFirst({ where: { reporterId: userId, targetType: 'group', targetId: groupId, status: 0 } });
    if (dup) return { ok: true, duplicated: true };
    await this.prisma.report.create({
      data: { reporterId: userId, targetUserId: group.ownerId, targetType: 'group', targetId: groupId, reason: r, extra: JSON.stringify({ groupName: group.name, kind: group.kind }) },
    });
    return { ok: true };
  }

  // ---------- 会话列表 / 消息页用 ----------

  /** 我进过的、没有从列表里删掉的群（消息列表用） */
  async myGroups(userId: bigint) {
    const mine = await this.prisma.groupMember.findMany({ where: { userId, hidden: false } });
    if (!mine.length) return [];
    let groups = await this.prisma.chatGroup.findMany({ where: { id: { in: mine.map((m) => m.groupId) } } });
    // 兜底：列表里有已经过期但还没解散的群，当场解散（正常情况下定时器早就处理了）
    const overdue = groups.filter((g) => g.status === 0 && g.expireAt && g.expireAt.getTime() <= Date.now());
    if (overdue.length) {
      for (const g of overdue) await this.systemDissolve(g.id, 'expire');
      groups = await this.prisma.chatGroup.findMany({ where: { id: { in: mine.map((m) => m.groupId) } } });
    }
    const counts = await this.prisma.groupMember.groupBy({ by: ['groupId'], where: { groupId: { in: groups.map((g) => g.id) }, status: 0 }, _count: { _all: true } });
    const countMap = new Map(counts.map((c) => [c.groupId.toString(), c._count._all]));
    const groupMap = new Map(groups.map((g) => [g.id.toString(), g]));
    return mine
      .filter((m) => groupMap.has(m.groupId.toString()))
      .map((m) => {
        const group = groupMap.get(m.groupId.toString())!;
        return { group, member: m, state: groupStateOf(group, m), memberCount: countMap.get(group.id.toString()) ?? 0 };
      });
  }

  /** 群的公开信息（列表、推送里用的那一份） */
  async summary(group: GroupRow, memberCount?: number) {
    const conv = await this.prisma.conversation.findUnique({ where: { groupId: group.id }, select: { id: true } });
    const count = memberCount ?? (await this.prisma.groupMember.count({ where: { groupId: group.id, status: 0 } }));
    return {
      id: group.id.toString(),
      conversationId: conv?.id.toString() ?? null,
      name: group.name,
      avatar: group.avatar,
      notice: group.notice,
      ownerId: group.ownerId.toString(),
      kind: group.kind,
      refId: group.refId.toString(),
      status: group.status,
      memberCount: count,
      memberLimit: group.memberLimit,
      endAt: group.endAt,
      expireAt: group.expireAt,
    };
  }

  // ---------- 后台 ----------

  /** 群列表：cat = alive 正常 / dissolved 已解散 / closed 被关闭 / all；q 搜群名、群 id、群主短号 */
  async adminList(opts: { q?: string; cat?: string; page?: number; size?: number }) {
    const kw = (opts.q ?? '').trim().slice(0, 50);
    const or: any[] = [];
    if (kw) {
      or.push({ name: { contains: kw } });
      if (/^\d{1,19}$/.test(kw)) or.push({ id: BigInt(kw) });
      const owner = /^\d{6}$/.test(kw) ? await this.prisma.user.findFirst({ where: { shortId: kw }, select: { id: true } }) : null;
      if (owner) or.push({ ownerId: owner.id });
    }
    const base: any = or.length ? { OR: or } : {};
    const CATS: Record<string, any> = { alive: { status: 0 }, dissolved: { status: 1 }, closed: { status: 2 }, all: {} };
    const cat = opts.cat && CATS[opts.cat] ? opts.cat : 'alive';
    const size = Math.min(Math.max(Math.floor(opts.size ?? 20) || 20, 10), 100);
    const page = Math.max(Math.floor(opts.page ?? 1) || 1, 1);
    const where = { ...base, ...CATS[cat] };
    const [total, counts, groups] = await Promise.all([
      this.prisma.chatGroup.count({ where }),
      Promise.all(Object.entries(CATS).map(async ([k, w]) => [k, await this.prisma.chatGroup.count({ where: { ...base, ...w } })] as const)).then(Object.fromEntries),
      this.prisma.chatGroup.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size }),
    ]);
    const ids = groups.map((g) => g.id);
    const [members, owners, convs] = ids.length
      ? await Promise.all([
          this.prisma.groupMember.groupBy({ by: ['groupId'], where: { groupId: { in: ids }, status: 0 }, _count: { _all: true } }),
          this.prisma.user.findMany({ where: { id: { in: groups.map((g) => g.ownerId) } }, select: { id: true, nickname: true, shortId: true } }),
          this.prisma.conversation.findMany({ where: { groupId: { in: ids } }, select: { id: true, groupId: true, lastMsgAt: true } }),
        ])
      : [[], [], []];
    const pending = ids.length
      ? await this.prisma.report.groupBy({ by: ['targetId'], where: { targetType: 'group', targetId: { in: ids }, status: 0 }, _count: { _all: true } })
      : [];
    const memberMap = new Map(members.map((c) => [c.groupId.toString(), c._count._all]));
    const ownerMap = new Map(owners.map((o) => [o.id.toString(), o]));
    const convMap = new Map(convs.map((c) => [c.groupId!.toString(), c]));
    const pendingMap = new Map(pending.map((p) => [p.targetId.toString(), p._count._all]));
    return {
      total, page, size, counts,
      list: groups.map((g) => ({
        id: g.id, name: g.name, kind: g.kind, refId: g.refId, status: g.status, notice: g.notice,
        owner: ownerMap.get(g.ownerId.toString()) ?? null,
        members: memberMap.get(g.id.toString()) ?? 0, memberLimit: g.memberLimit,
        conversationId: convMap.get(g.id.toString())?.id ?? null,
        lastMsgAt: convMap.get(g.id.toString())?.lastMsgAt ?? null,
        pendingReports: pendingMap.get(g.id.toString()) ?? 0,
        endAt: g.endAt, expireAt: g.expireAt, createdAt: g.createdAt,
      })),
    };
  }

  /** 群成员（含已经退出 / 被移出的） */
  async adminMembers(groupId: bigint) {
    await this.mustGroup(groupId);
    const rows = await this.prisma.groupMember.findMany({ where: { groupId }, orderBy: [{ status: 'asc' }, { joinedAt: 'asc' }] });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, nickname: true, shortId: true, avatar: true, gender: true, status: true } });
    const map = new Map(users.map((u) => [u.id.toString(), u]));
    return rows.map((r) => ({ ...(map.get(r.userId.toString()) ?? { id: r.userId }), role: r.role, memberStatus: r.status, joinedAt: r.joinedAt, leftAt: r.leftAt }));
  }

  /** 最近的群消息（新的在前），beforeId 往前翻页 */
  async adminMessages(groupId: bigint, beforeId?: bigint) {
    await this.mustGroup(groupId);
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    if (!conv) return [];
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const rows = await this.prisma.message.findMany({
      where: { conversationId: conv.id, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const senders = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((m) => m.senderId))] } }, select: { id: true, nickname: true, shortId: true, avatar: true } });
    const senderMap = new Map(senders.map((s) => [s.id.toString(), s]));
    return rows.map((m) => {
      let content = '';
      try { content = this.crypto.decrypt(key, m.cipherContent); } catch { content = ''; }
      return { id: m.id, type: m.type, content, createdAt: m.createdAt, sender: senderMap.get(m.senderId.toString()) ?? null };
    });
  }

  /** 关闭（违规）/ 恢复。只能在「正常」和「被平台关闭」之间切；已经解散的群不能恢复 */
  async adminSetClosed(groupId: bigint, closed: boolean) {
    const group = await this.mustGroup(groupId);
    if (group.status === 1) throw new BadRequestException('这个群已经解散了');
    if ((group.status === 2) === closed) return { ok: true, status: group.status };
    const next = await this.prisma.chatGroup.update({ where: { id: groupId }, data: { status: closed ? 2 : 0, closedAt: closed ? new Date() : null } });
    // 关闭期间不会自动解散；恢复以后到期定时器重新挂上（已经过期的马上解散）
    this.arm(groupId, closed ? null : next.expireAt);
    await this.sysMessage(next, group.ownerId, closed ? 'close' : 'reopen', closed ? '这个群因违规已被平台关闭' : '这个群已恢复');
    await this.push(await this.activeIds(groupId), closed ? 'closed' : 'reopen', groupId);
    return { ok: true, status: next.status };
  }

  /** 平台把人移出（群主也可以被移出：那就等于这个群没有群主了，一般应该直接关群） */
  async adminRemove(groupId: bigint, targetId: bigint) {
    const group = await this.mustGroup(groupId);
    const target = await this.member(groupId, targetId);
    if (target?.role === 'owner') throw new BadRequestException('不能移出群主，可以关闭这个群');
    return this.remove(group, targetId, null, 3);
  }

  /** 把一个号加进群（后台测试用；正式的进群走约单 / 参与）。who：6 位短号或用户 id */
  async adminAdd(groupId: bigint, who: string) {
    const user = await this.userOf(who);
    await this.systemJoin(user.id, groupId);
    return { ok: true, userId: user.id, nickname: user.nickname };
  }

  /** 建一个测试群（kind=test）。owner / members：6 位短号或用户 id */
  async adminCreateTest(owner: string, name: string, members: string[] = [], opts: { memberLimit?: number; expireInSec?: number } = {}) {
    const o = await this.userOf(owner);
    const expireAt = opts.expireInSec && opts.expireInSec > 0 ? new Date(Date.now() + opts.expireInSec * 1000) : null;
    const g = await this.createSystemGroup({ ownerId: o.id, name: name || '测试群', kind: 'test', memberLimit: opts.memberLimit, endAt: expireAt ? new Date() : null, expireAt });
    for (const m of members) await this.adminAdd(BigInt(g.id), m);
    return this.adminMembers(BigInt(g.id)).then((list) => ({ ...g, members: list }));
  }

  /** 彻底删掉一个测试群（只认 kind=test）：成员、消息、会话、举报一起删。正式的群不能这样删 */
  async adminDeleteTest(groupId: bigint) {
    const group = await this.mustGroup(groupId);
    if (group.kind !== 'test') throw new ForbiddenException('只能删除测试群');
    const members = await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } });
    const conv = await this.prisma.conversation.findUnique({ where: { groupId } });
    await this.prisma.$transaction(async (tx) => {
      if (conv) {
        const mids = (await tx.message.findMany({ where: { conversationId: conv.id }, select: { id: true } })).map((m) => m.id);
        if (mids.length) {
          await tx.channelReaction.deleteMany({ where: { messageId: { in: mids } } });
          await tx.report.deleteMany({ where: { targetType: 'message', targetId: { in: mids } } });
        }
        await tx.messagePin.deleteMany({ where: { conversationId: conv.id } });
        await tx.messageHide.deleteMany({ where: { conversationId: conv.id } });
        await tx.message.deleteMany({ where: { conversationId: conv.id } });
        await tx.conversation.delete({ where: { id: conv.id } });
      }
      await tx.report.deleteMany({ where: { targetType: 'group', targetId: groupId } });
      await tx.groupMember.deleteMany({ where: { groupId } });
      await tx.chatGroup.delete({ where: { id: groupId } });
    });
    this.arm(groupId, null);
    await this.registry.deliver(members.map((m) => m.userId), { op: 'conv_refresh' });
    return { ok: true, members: members.length };
  }

  // ---------- 内部 ----------

  private async doDissolve(group: GroupRow, actorId: bigint, text: string) {
    // 先把状态从「正常」改成「已解散」，改到了才算是我解散的：定时器和兜底同时碰到、或者以后有多个节点，也只会解散一次、只出一行小字
    const claimed = await this.prisma.chatGroup.updateMany({ where: { id: group.id, status: 0 }, data: { status: 1, closedAt: new Date() } });
    this.arm(group.id, null);
    if (claimed.count === 0) return { ok: true };
    const members = await this.activeIds(group.id);
    await this.sysMessage(group, actorId, 'dissolve', text);
    await this.push(members, 'dissolved', group.id);
    return { ok: true };
  }

  /** 移出：how 2=群主移出 3=平台移出 */
  private async remove(group: GroupRow, targetId: bigint, operatorId: bigint | null, how: 2 | 3) {
    const target = await this.member(group.id, targetId);
    if (!target || target.status !== 0) throw new NotFoundException('这个人不在群里');
    if (target.role === 'owner') throw new ForbiddenException('不能移出群主');
    const user = await this.prisma.user.findUnique({ where: { id: targetId }, select: { nickname: true } });
    const name = user?.nickname ?? '';
    if (group.status === 0) await this.sysMessage(group, operatorId ?? group.ownerId, 'kick', how === 2 ? `${name} 被群主移出了群聊` : `${name} 被平台移出了群聊`);
    await this.prisma.groupMember.update({ where: { groupId_userId: { groupId: group.id, userId: targetId } }, data: { status: how, leftAt: new Date() } });
    await this.push([...(await this.activeIds(group.id)), targetId], 'kick', group.id, { userId: targetId.toString(), nickname: name });
    return { ok: true };
  }

  /**
   * 群里中间那行灰色小字（type=sys）：和普通消息一样加密存、一样推给在群里的人。
   * content 是 {k, text}：k 是哪种事（join / leave / kick / dissolve / rename / notice / close / reopen / create），text 是给人看的那句话。
   */
  private async sysMessage(group: GroupRow, actorId: bigint, k: string, text: string) {
    const conv = await this.prisma.conversation.findUnique({ where: { groupId: group.id } });
    if (!conv) return;
    const key = this.crypto.unwrapKey(conv.wrappedKey);
    const content = JSON.stringify({ k, text });
    const msg = await this.prisma.message.create({
      data: { conversationId: conv.id, senderId: actorId, receiverId: null, type: 'sys', cipherContent: this.crypto.encrypt(key, content) },
    });
    await this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: msg.createdAt } });
    const payload: MessagePayload = {
      id: msg.id.toString(), conversationId: conv.id.toString(), convType: 2, groupId: group.id.toString(), groupName: group.name,
      senderId: actorId.toString(), senderNickname: '', senderAvatar: '', receiverId: null,
      type: 'sys', content, createdAt: msg.createdAt.toISOString(),
    };
    await this.registry.deliver(await this.activeIds(group.id), { op: 'msg', data: payload });
  }

  /**
   * 推给相关的人：{ op: 'group', data: { event, groupId, conversationId, group: 最新的群信息, userId?, nickname? } }。
   * event：create / join / leave / kick / info / dissolved / closed / reopen。
   * 后面再跟一个 conv_refresh，老的消息列表逻辑靠它刷新。
   */
  private async push(userIds: bigint[], event: string, groupId: bigint, extra: Record<string, unknown> = {}) {
    const ids = [...new Set(userIds.map((u) => u.toString()))];
    if (!ids.length) return;
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group) return;
    const summary = await this.summary(group);
    try {
      await this.registry.deliver(ids, { op: 'group', data: { event, groupId: groupId.toString(), conversationId: summary.conversationId, group: summary, ...extra } });
      await this.registry.deliver(ids, { op: 'conv_refresh' });
    } catch (e) {
      this.logger.warn(`群推送失败 ${groupId} ${event}: ${e}`);
    }
  }

  private async lastMsgId(groupId: bigint): Promise<bigint> {
    const conv = await this.prisma.conversation.findUnique({ where: { groupId }, select: { id: true } });
    if (!conv) return 0n;
    const last = await this.prisma.message.findFirst({ where: { conversationId: conv.id }, orderBy: { id: 'desc' }, select: { id: true } });
    return last?.id ?? 0n;
  }

  private async mustGroup(groupId: bigint) {
    const group = await this.prisma.chatGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('群不存在');
    return group;
  }

  private async userOf(who: string) {
    const w = String(who ?? '').trim();
    const user = /^\d{6}$/.test(w)
      ? await this.prisma.user.findUnique({ where: { shortId: w }, select: { id: true, nickname: true } })
      : /^\d{1,19}$/.test(w) ? await this.prisma.user.findUnique({ where: { id: BigInt(w) }, select: { id: true, nickname: true } }) : null;
    if (!user) throw new NotFoundException(`用户不存在：${w}`);
    return user;
  }
}

function cleanName(raw: string): string {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
}
