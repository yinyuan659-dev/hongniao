import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService, AiPayException } from '../ai/ai-gateway.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { ImService } from '../im/im.service';
import { normalize } from '../hn/deep.service';
import { MatchConfig, getMatchConfig, nextRecAt, profileReady, recDay, relationOf } from '../common/chat-gate';
import { Person, common, compatible, score, toPerson } from './match.rules';
import { Brief, ICE_PROMPT, REASON_PROMPT, iceInput, reasonInput } from './match.prompt';

/** 挑人时最多看多少个候选（按注册时间从新到旧）。人多了以后要换成先在数据库里按城市 / 年龄筛一遍 */
const POOL = 3000;
/** 打开推荐页时最多等 AI 写理由多久（毫秒）；超时先显示共同点，AI 写完了下次进来就有 */
const REASON_WAIT_MS = 8000;

/**
 * 喜欢相关的拒绝：HTTP 403，带 reason 让客户端知道弹哪张提示。
 *   need_profile  基本情况没填完，不能点喜欢
 *   like_quota    今天的名额用完了
 */
export class MatchException extends HttpException {
  constructor(public readonly reason: string, message: string) {
    super({ message, reason }, 403);
  }
}

const USER_SELECT = { id: true, nickname: true, avatar: true, gender: true, age: true, cityName: true, status: true, hidden: true } as const;
type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

/** 一个人：账号 + 画像里推荐要用到的部分 */
interface Loaded {
  id: bigint;
  user: UserRow;
  person: Person;
  /** 基本情况填完了（能点喜欢、能被推荐） */
  ready: boolean;
  brief: Brief;
}

/**
 * 每日推荐、喜欢 / 跳过、互相喜欢。
 * 「没有互相喜欢不能聊天」的强制在 common/chat-gate.ts（im / call 发消息、打电话前都会查）。
 */
@Injectable()
export class MatchService {
  private readonly logger = new Logger('Match');
  /** 正在让 AI 写的推荐理由 / 开场白：同一对人同时来两个请求只调一次模型，不重复花钱 */
  private readonly writing = new Map<string, Promise<unknown>>();
  /** 正在给谁挑今天的推荐 */
  private readonly picking = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly registry: ConnectionRegistry,
    private readonly im: ImService,
  ) {}

  // ---------- 每日推荐 ----------

  /** 广场 → 遇见 → 推荐：今天的那几位。第一次进来时现挑，挑好以后当天不变 */
  async today(userId: bigint) {
    const cfg = await getMatchConfig(this.prisma);
    const me = await this.one(userId);
    const day = recDay();
    const base = {
      day,
      /** 下一批什么时候来（下一个北京时间上午 10 点） */
      nextAt: nextRecAt(),
      /** 每天推荐几位 */
      limit: cfg.dailyRecs,
      /** 在遇见里自己点喜欢的名额 */
      quota: await this.quota(userId, cfg),
      /** 有几个人喜欢了我、我还没回应 */
      likedMe: (await this.likedMeRows(userId)).length,
    };
    // 基本情况没填完：不给推荐，页面上显示「先把基本情况填完」
    if (!me.ready) return { ...base, ready: false, list: [] };

    let recs = await this.recsOf(userId, day);
    if (recs.length < cfg.dailyRecs) recs = await this.fill(me, day, recs.map((r) => r.targetId), cfg.dailyRecs);

    const ids = recs.map((r) => r.targetId);
    const [people, mine, theirs, reasons] = await Promise.all([
      this.load(ids),
      this.prisma.matchAction.findMany({ where: { userId, targetId: { in: ids } } }),
      this.prisma.matchAction.findMany({ where: { targetId: userId, userId: { in: ids } } }),
      this.prisma.matchReason.findMany({ where: { userId, targetId: { in: ids } } }),
    ]);
    const myKind = new Map(mine.map((a) => [a.targetId.toString(), a.kind]));
    const theirKind = new Map(theirs.map((a) => [a.userId.toString(), a.kind]));
    const text = new Map(reasons.filter((r) => r.text).map((r) => [r.targetId.toString(), r.text]));

    // 被封号、被隐藏、后来对我点了不合适的人，从今天的列表里拿掉
    const shown = recs
      .map((r) => people.get(r.targetId.toString()))
      .filter((p): p is Loaded => !!p && p.user.status === 0 && !p.user.hidden)
      .filter((p) => !['pass', 'end'].includes(theirKind.get(p.id.toString()) ?? ''));

    // 还没表态、理由还没写过的：让 AI 写（看推荐的人付钱；没有余额也没有 Key 就写不成，只显示共同点）
    const todo = shown.filter((p) => !text.has(p.id.toString()) && (myKind.get(p.id.toString()) ?? 'none') === 'none');
    if (todo.length) {
      const jobs = Promise.all(todo.map(async (p) => {
        const t = await this.reason(me, p, day);
        if (t) text.set(p.id.toString(), t);
      }));
      await Promise.race([jobs, new Promise((r) => setTimeout(r, REASON_WAIT_MS))]);
    }

    return {
      ...base,
      ready: true,
      list: shown.map((p) => {
        const k = p.id.toString();
        const kind = myKind.get(k) ?? 'none';
        const likedMe = theirKind.get(k) === 'like';
        return {
          ...this.brief(p),
          /** 共同点小标签（规则算的，不花钱） */
          tags: common(me.person, p.person),
          /** AI 写的推荐理由；空 = 没写成，只显示共同点 */
          reason: text.get(k) ?? '',
          /** none 还没表态 | liked 我喜欢了 | passed 我跳过了 | mutual 互相喜欢 */
          state: kind === 'like' ? (likedMe ? 'mutual' : 'liked') : kind === 'pass' || kind === 'end' ? 'passed' : 'none',
          likedMe,
        };
      }),
    };
  }

  private recsOf(userId: bigint, day: string) {
    return this.prisma.matchRec.findMany({ where: { userId, day }, orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
  }

  /** 今天的推荐不够数：再挑几位补上（人少的时候有几位给几位） */
  private async fill(me: Loaded, day: string, have: bigint[], want: number) {
    const key = me.id.toString();
    // 同时来了两个请求：后到的直接用已经有的，不重复挑
    if (!this.picking.has(key)) {
      this.picking.add(key);
      try {
        const picked = await this.pick(me, want - have.length, have);
        let sort = have.length;
        for (const p of picked) {
          await this.prisma.matchRec.create({ data: { userId: me.id, day, targetId: p.id, sort: sort++, score: p.score } }).catch(() => undefined);
        }
        if (picked.length) this.logger.log(`uid=${me.id} ${day} 推荐补了 ${picked.length} 位`);
      } finally {
        this.picking.delete(key);
      }
    }
    return this.recsOf(me.id, day);
  }

  /** 挑人：硬条件互相符合的里面，按分数从高到低取 n 位 */
  private async pick(me: Loaded, n: number, exclude: bigint[]): Promise<{ id: bigint; score: number }[]> {
    if (n <= 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        gender: me.user.gender === 1 ? 2 : 1, status: 0, hidden: false,
        id: { notIn: [me.id, ...exclude] },
      },
      orderBy: { id: 'desc' },
      take: POOL,
      select: { id: true },
    });
    if (!users.length) return [];
    const ids = users.map((u) => u.id);
    const [people, mine, theirs, before] = await Promise.all([
      this.load(ids),
      this.prisma.matchAction.findMany({ where: { userId: me.id, targetId: { in: ids } }, select: { targetId: true, kind: true } }),
      this.prisma.matchAction.findMany({ where: { targetId: me.id, userId: { in: ids } }, select: { userId: true, kind: true } }),
      this.prisma.matchRec.findMany({ where: { userId: me.id, targetId: { in: ids } }, select: { targetId: true } }),
    ]);
    const myKind = new Map(mine.map((a) => [a.targetId.toString(), a.kind]));
    const theirKind = new Map(theirs.map((a) => [a.userId.toString(), a.kind]));
    const seen = new Set(before.map((r) => r.targetId.toString()));

    const out: { id: bigint; score: number }[] = [];
    for (const p of people.values()) {
      const k = p.id.toString();
      // 对方基本情况没填完：不推荐
      if (!p.ready) continue;
      // 我已经喜欢 / 跳过 / 结束过的：不再推荐
      if ((myKind.get(k) ?? 'none') !== 'none') continue;
      // 对方跳过了我或者结束了联系：不再互相推荐
      if (['pass', 'end'].includes(theirKind.get(k) ?? '')) continue;
      if (compatible(me.person, p.person)) continue;
      let s = score(me.person, p.person);
      // 对方已经喜欢我了：往前排，更容易配上
      if (theirKind.get(k) === 'like') s += 20;
      // 以前推荐过、我当时没表态的：可以再出现，但往后排
      if (seen.has(k)) s -= 10;
      out.push({ id: p.id, score: s });
    }
    out.sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : -1));
    return out.slice(0, n);
  }

  // ---------- 喜欢 / 跳过 ----------

  /** 喜欢一个人。对方已经喜欢我 → 马上互相喜欢，返回 matched: true（客户端弹庆祝页） */
  async like(userId: bigint, targetId: bigint) {
    if (userId === targetId) throw new BadRequestException('不能喜欢自己');
    const [me, target] = await Promise.all([this.one(userId), this.one(targetId)]);
    if (target.user.status !== 0) throw new NotFoundException('用户不存在');
    if (me.user.gender === target.user.gender) throw new ForbiddenException('无法查看该用户');
    if (!me.ready) throw new MatchException('need_profile', '先把基本情况填完，才能喜欢别人');

    const cfg = await getMatchConfig(this.prisma);
    const day = recDay();
    const [mine, theirs, rec] = await Promise.all([
      this.action(userId, targetId),
      this.action(targetId, userId),
      this.prisma.matchRec.findFirst({ where: { userId, targetId }, select: { id: true } }),
    ]);
    if (mine?.kind === 'end' || theirs?.kind === 'end') throw new BadRequestException('你们已经结束联系了');

    if (mine?.kind !== 'like') {
      // 每日推荐里的人、回应对方的喜欢：不占名额。其余的每天最多 dailyLikes 个，取消喜欢不退
      const back = theirs?.kind === 'like';
      const free = back || !!rec || mine?.quotaDay === day;
      if (!free) {
        const q = await this.quota(userId, cfg);
        if (q.left <= 0) throw new MatchException('like_quota', `今天的 ${cfg.dailyLikes} 个喜欢用完了，明天上午 10 点恢复`);
      }
      const data = {
        kind: 'like', source: back ? 'back' : rec ? 'rec' : 'browse', likedAt: new Date(), seen: false, matchedAt: null, matchSeen: false,
        ...(free ? {} : { quotaDay: day }),
      };
      await this.prisma.matchAction.upsert({ where: { userId_targetId: { userId, targetId } }, create: { userId, targetId, ...data }, update: data });
    }

    // 写完自己的再看对方的：两个人同时点喜欢，后写完的那一个会在这里发现已经互相喜欢
    const now = await this.action(targetId, userId);
    const matched = now?.kind === 'like';
    let conversationId: bigint | null = null;
    if (matched) {
      conversationId = await this.onMatched(me, target);
    } else if (mine?.kind !== 'like') {
      // 告诉对方「有人喜欢你」（只是让消息页的数字刷新，不带是谁；对方跳过了我的话不打扰）
      if (now?.kind !== 'pass') await this.registry.deliver([targetId], { op: 'match', event: 'liked', data: {} });
    }
    return {
      state: matched ? 'mutual' : 'liked',
      matched,
      peer: this.brief(target).user,
      conversationId,
      quota: await this.quota(userId, cfg),
    };
  }

  /** 两个人刚互相喜欢：记下时间、建好会话、通知对方。返回会话 id */
  private async onMatched(me: Loaded, target: Loaded) {
    const conv = await this.im.getOrCreateSingleConversation(me.id, target.id);
    const mine = await this.action(me.id, target.id);
    if (!mine?.matchedAt) {
      const at = new Date();
      await this.prisma.$transaction([
        // 点喜欢的这一方马上会看到庆祝页，算看过了；对方那边等 TA 上线时弹
        this.prisma.matchAction.update({ where: { userId_targetId: { userId: me.id, targetId: target.id } }, data: { matchedAt: at, matchSeen: true, seen: true } }),
        this.prisma.matchAction.update({ where: { userId_targetId: { userId: target.id, targetId: me.id } }, data: { matchedAt: at, matchSeen: false, seen: true } }),
        // 刚配上的会话排到消息列表最前面
        this.prisma.conversation.update({ where: { id: conv.id }, data: { lastMsgAt: at } }),
      ]);
      await this.registry.deliver([target.id], {
        op: 'match', event: 'matched',
        data: { peer: { id: me.id.toString(), nickname: me.user.nickname, avatar: me.user.avatar }, conversationId: conv.id.toString() },
      });
      await this.registry.deliver([me.id, target.id], { op: 'conv_refresh' });
      this.logger.log(`互相喜欢: ${me.id} <-> ${target.id}`);
    }
    return conv.id;
  }

  /** 跳过 / 不合适：以后不再互相推荐，对方不会收到通知 */
  async pass(userId: bigint, targetId: bigint) {
    if (userId === targetId) throw new BadRequestException('参数不正确');
    const [mine, theirs] = await Promise.all([this.action(userId, targetId), this.action(targetId, userId)]);
    if (mine?.kind === 'end') return { state: 'ended' };
    if (mine?.kind === 'like' && theirs?.kind === 'like') {
      throw new BadRequestException('你们已经互相喜欢了，想结束请在聊天页右上角选「不合适，不再联系」');
    }
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) throw new NotFoundException('用户不存在');
    const data = { kind: 'pass', matchedAt: null };
    await this.prisma.matchAction.upsert({ where: { userId_targetId: { userId, targetId } }, create: { userId, targetId, ...data }, update: data });
    return { state: 'none', passed: true };
  }

  /** 取消喜欢：只有对方还没回应时能取消。当天的名额不退 */
  async unlike(userId: bigint, targetId: bigint) {
    const [mine, theirs] = await Promise.all([this.action(userId, targetId), this.action(targetId, userId)]);
    if (mine?.kind !== 'like') return { state: theirs?.kind === 'like' ? 'likedMe' : 'none' };
    if (theirs?.kind === 'like') throw new BadRequestException('你们已经互相喜欢了，想结束请在聊天页右上角选「不合适，不再联系」');
    await this.prisma.matchAction.update({ where: { id: mine.id }, data: { kind: 'none' } });
    return { state: 'none' };
  }

  /**
   * 聊天页「不合适，不再联系」：两边都不能再给对方发消息，也不再互相推荐。
   * 我这边聊天从列表里收起；对方那边聊天还在，只是提示「对方已结束聊天」。
   */
  async end(userId: bigint, targetId: bigint) {
    if (userId === targetId) throw new BadRequestException('参数不正确');
    const rel = await relationOf(this.prisma, userId, targetId);
    if (rel.endedBy === 'me') return { state: 'ended' };
    // 没聊过也没互相喜欢的人用不着「结束联系」，点「跳过」就行
    if (rel.state !== 'mutual' && rel.chatReason !== 'legacy' && rel.chatReason !== 'legacy_expired' && rel.endedBy !== 'peer') {
      throw new BadRequestException('你们还没有开始聊天');
    }
    await this.prisma.matchAction.upsert({
      where: { userId_targetId: { userId, targetId } },
      create: { userId, targetId, kind: 'end' },
      update: { kind: 'end' },
    });
    await this.registry.deliver([targetId], { op: 'match', event: 'ended', data: { peerId: userId.toString() } });
    await this.registry.deliver([userId, targetId], { op: 'conv_refresh' });
    return { state: 'ended' };
  }

  /** 举报一个人（画像网页、聊天页右上角）。记进和消息举报同一张表，后台在举报列表里处理 */
  async report(userId: bigint, targetId: bigint, reason: string) {
    if (userId === targetId) throw new BadRequestException('不能举报自己');
    const r = (reason ?? '').trim().slice(0, 500);
    if (!r) throw new BadRequestException('请选择举报原因');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: { id: true } });
    if (!target) throw new NotFoundException('用户不存在');
    const dup = await this.prisma.report.findFirst({ where: { reporterId: userId, targetType: 'user', targetId, status: 0 }, select: { id: true } });
    if (dup) return { ok: true, duplicated: true };
    await this.prisma.report.create({ data: { reporterId: userId, targetUserId: targetId, targetType: 'user', targetId, reason: r } });
    return { ok: true };
  }

  // ---------- 喜欢列表、消息页顶上的入口 ----------

  /** 消息页顶上的三个数字 + 还没看过的「互相喜欢」（用来补弹庆祝页） */
  async summary(userId: bigint) {
    const cfg = await getMatchConfig(this.prisma);
    const [likedMe, mine, me] = await Promise.all([
      this.likedMeRows(userId),
      this.prisma.matchAction.findMany({ where: { userId, kind: 'like' }, select: { targetId: true, matchSeen: true, matchedAt: true } }),
      this.prisma.profile.findUnique({ where: { userId }, select: { confirmedAt: true, hard: true } }),
    ]);
    const back = mine.length
      ? await this.prisma.matchAction.findMany({ where: { targetId: userId, kind: 'like', userId: { in: mine.map((m) => m.targetId) } }, select: { userId: true } })
      : [];
    const mutual = new Set(back.map((b) => b.userId.toString()));
    const unseen = mine.filter((m) => mutual.has(m.targetId.toString()) && !m.matchSeen);
    const people = await this.load(unseen.map((m) => m.targetId));
    const newMatches: { peer: ReturnType<MatchService['brief']>['user']; conversationId: bigint }[] = [];
    for (const m of unseen) {
      const p = people.get(m.targetId.toString());
      if (!p || p.user.status !== 0) continue;
      const conv = await this.im.getOrCreateSingleConversation(userId, p.id);
      newMatches.push({ peer: this.brief(p).user, conversationId: conv.id });
    }
    return {
      /** 喜欢我、我还没回应的 */
      likedMe: likedMe.length,
      /** 其中我还没在列表里看过的（消息页的红点数字） */
      likedMeNew: likedMe.filter((r) => !r.seen).length,
      /** 我喜欢、对方还没回应的 */
      liked: mine.length - mutual.size,
      mutual: mutual.size,
      /** 对方回了我的喜欢、我还没看过庆祝页的：客户端弹出来，然后调 seen */
      newMatches,
      quota: await this.quota(userId, cfg),
      ready: profileReady(me),
    };
  }

  /** 庆祝页看过了 */
  async seen(userId: bigint, targetId: bigint) {
    await this.prisma.matchAction.updateMany({ where: { userId, targetId, kind: 'like' }, data: { matchSeen: true } });
    return { ok: true };
  }

  /** 喜欢列表：tab = likedMe 喜欢我的 | liked 我喜欢的 | mutual 互相喜欢 */
  async list(userId: bigint, tab: string) {
    const me = await this.one(userId);
    let rows: { peerId: bigint; at: Date | null; isNew: boolean }[];
    if (tab === 'likedMe') {
      const liked = await this.likedMeRows(userId);
      rows = liked.map((r) => ({ peerId: r.userId, at: r.likedAt, isNew: !r.seen }));
      // 打开列表就算看过了，消息页的红点清掉
      if (liked.some((r) => !r.seen)) {
        await this.prisma.matchAction.updateMany({ where: { id: { in: liked.filter((r) => !r.seen).map((r) => r.id) } }, data: { seen: true } });
      }
    } else {
      const mine = await this.prisma.matchAction.findMany({ where: { userId, kind: 'like' }, orderBy: { likedAt: 'desc' }, take: 300 });
      const back = mine.length
        ? await this.prisma.matchAction.findMany({ where: { targetId: userId, userId: { in: mine.map((m) => m.targetId) } }, select: { userId: true, kind: true } })
        : [];
      const kind = new Map(back.map((b) => [b.userId.toString(), b.kind]));
      const isMutual = tab === 'mutual';
      rows = mine
        // 对方结束了联系的，两个列表里都不出现
        .filter((m) => kind.get(m.targetId.toString()) !== 'end' && (kind.get(m.targetId.toString()) === 'like') === isMutual)
        .map((m) => ({ peerId: m.targetId, at: isMutual ? m.matchedAt : m.likedAt, isNew: false }));
      if (isMutual) rows.sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
    }
    const people = await this.load(rows.map((r) => r.peerId));
    const list: unknown[] = [];
    for (const r of rows) {
      const p = people.get(r.peerId.toString());
      if (!p || p.user.status !== 0) continue;
      list.push({
        ...this.brief(p),
        at: r.at,
        isNew: r.isNew,
        tags: common(me.person, p.person, 2),
        conversationId: tab === 'mutual' ? (await this.im.getOrCreateSingleConversation(userId, p.id)).id : null,
      });
    }
    return { tab: ['likedMe', 'liked', 'mutual'].includes(tab) ? tab : 'liked', list };
  }

  /** 喜欢了我、我还没回应、也没点过不合适的人（新的在前） */
  private async likedMeRows(userId: bigint) {
    const rows = await this.prisma.matchAction.findMany({ where: { targetId: userId, kind: 'like' }, orderBy: { likedAt: 'desc' }, take: 300 });
    if (!rows.length) return [];
    const [mine, alive] = await Promise.all([
      this.prisma.matchAction.findMany({ where: { userId, targetId: { in: rows.map((r) => r.userId) } }, select: { targetId: true, kind: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) }, status: 0 }, select: { id: true } }),
    ]);
    const kind = new Map(mine.map((m) => [m.targetId.toString(), m.kind]));
    const ok = new Set(alive.map((u) => u.id.toString()));
    return rows.filter((r) => ok.has(r.userId.toString()) && (kind.get(r.userId.toString()) ?? 'none') === 'none');
  }

  // ---------- 两个人的关系（画像网页底部的按钮、聊天页顶上的提示都用它） ----------

  async relation(userId: bigint, peerId: bigint) {
    const cfg = await getMatchConfig(this.prisma);
    const [rel, quota, me] = await Promise.all([
      relationOf(this.prisma, userId, peerId),
      this.quota(userId, cfg),
      this.prisma.profile.findUnique({ where: { userId }, select: { confirmedAt: true, hard: true } }),
    ]);
    return { ...rel, quota, ready: profileReady(me) };
  }

  /** 画像网页用：关系 + 共同点 + 推荐理由（只有推荐过的人才有「为什么推荐给你」） */
  async forCard(userId: bigint, targetId: bigint) {
    const [rel, people, rec, reason] = await Promise.all([
      this.relation(userId, targetId),
      this.load([userId, targetId]),
      this.prisma.matchRec.findFirst({ where: { userId, targetId }, select: { id: true } }),
      this.prisma.matchReason.findUnique({ where: { userId_targetId: { userId, targetId } }, select: { text: true } }),
    ]);
    const me = people.get(userId.toString());
    const target = people.get(targetId.toString());
    const tags = me?.ready && target?.ready ? common(me.person, target.person) : [];
    return {
      ...rel,
      /** 每日推荐里出现过这个人：点喜欢不占名额，画像顶上显示「为什么推荐给你」 */
      recommended: !!rec,
      tags,
      reason: rec ? (reason?.text ?? '') : '',
    };
  }

  // ---------- AI 写的推荐理由、开场白 ----------

  /** 让 AI 写「为什么把 peer 推荐给 me」。写成了存库并返回；写不成（没余额没 Key / AI 不可用）返回空字符串 */
  private reason(me: Loaded, peer: Loaded, day: string): Promise<string> {
    return this.once(`reason:${me.id}:${peer.id}`, async () => {
      try {
        const r = await this.gateway.chat({
          userId: me.id, feature: 'reason', groupKey: `reason:${day}`, json: true, maxTokens: 200, temperature: 0.7,
          messages: [
            { role: 'system', content: REASON_PROMPT },
            { role: 'user', content: reasonInput(me.brief, peer.brief, common(me.person, peer.person)) },
          ],
        });
        const text = clean(parseJson(r.content)?.reason).slice(0, 120);
        if (!text) return '';
        await this.prisma.matchReason.upsert({
          where: { userId_targetId: { userId: me.id, targetId: peer.id } },
          create: { userId: me.id, targetId: peer.id, text },
          update: { text },
        });
        return text;
      } catch (e) {
        // 没有余额也没有 Key 是正常情况，不用记日志
        if (!(e instanceof AiPayException) || e.reason === 'ai_down') this.logger.warn(`uid=${me.id} 推荐理由没写成: ${(e as Error).message}`);
        return '';
      }
    });
  }

  /**
   * 互相喜欢后，AI 帮我想两句开场白（我付钱）。写过一次就存下来。
   * 没有余额也没有 Key、或者 AI 不可用：返回空数组，庆祝页不显示这一块。
   */
  async icebreakers(userId: bigint, peerId: bigint): Promise<{ lines: string[] }> {
    const rel = await relationOf(this.prisma, userId, peerId);
    if (rel.state !== 'mutual') return { lines: [] };
    const saved = await this.prisma.matchReason.findUnique({ where: { userId_targetId: { userId, targetId: peerId } }, select: { icebreakers: true } });
    if (Array.isArray(saved?.icebreakers)) return { lines: saved!.icebreakers.filter((x): x is string => typeof x === 'string') };

    const lines = await this.once(`ice:${userId}:${peerId}`, async () => {
      try {
        const [me, peer] = await Promise.all([this.one(userId), this.one(peerId)]);
        const r = await this.gateway.chat({
          userId, feature: 'ice', groupKey: `ice:${peerId}`, json: true, maxTokens: 200, temperature: 0.9,
          messages: [
            { role: 'system', content: ICE_PROMPT },
            { role: 'user', content: iceInput(me.brief, peer.brief) },
          ],
        });
        const raw = parseJson(r.content)?.lines;
        const out = Array.isArray(raw) ? [...new Set(raw.map((x) => clean(x).slice(0, 60)).filter(Boolean))].slice(0, 2) : [];
        if (!out.length) return [];
        await this.prisma.matchReason.upsert({
          where: { userId_targetId: { userId, targetId: peerId } },
          create: { userId, targetId: peerId, icebreakers: out },
          update: { icebreakers: out },
        });
        return out;
      } catch (e) {
        if (!(e instanceof AiPayException) || e.reason === 'ai_down') this.logger.warn(`uid=${userId} 开场白没写成: ${(e as Error).message}`);
        return [] as string[];
      }
    });
    return { lines };
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.writing.get(key) as Promise<T> | undefined;
    if (running) return running;
    const job = fn().finally(() => this.writing.delete(key));
    this.writing.set(key, job);
    return job;
  }

  // ---------- 内部 ----------

  private action(userId: bigint, targetId: bigint) {
    return this.prisma.matchAction.findUnique({ where: { userId_targetId: { userId, targetId } } });
  }

  /** 在遇见里自己点喜欢的名额：今天用了几个、还剩几个 */
  private async quota(userId: bigint, cfg: MatchConfig) {
    const used = await this.prisma.matchAction.count({ where: { userId, quotaDay: recDay() } });
    return { limit: cfg.dailyLikes, used, left: Math.max(cfg.dailyLikes - used, 0) };
  }

  private async one(userId: bigint): Promise<Loaded> {
    const p = (await this.load([userId])).get(userId.toString());
    if (!p) throw new NotFoundException('用户不存在');
    return p;
  }

  /** 一次取一批人：账号 + 画像 */
  private async load(ids: bigint[]): Promise<Map<string, Loaded>> {
    const out = new Map<string, Loaded>();
    if (!ids.length) return out;
    const [users, profiles] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT }),
      this.prisma.profile.findMany({ where: { userId: { in: ids } }, select: { userId: true, confirmedAt: true, hard: true, soft: true, deep: true, flags: true } }),
    ]);
    const prof = new Map(profiles.map((p) => [p.userId.toString(), p]));
    for (const u of users) {
      const p = prof.get(u.id.toString());
      const person = toPerson(u.id, u.gender, p?.hard, p?.soft, p?.deep, p?.flags);
      const deep = normalize(p?.deep);
      out.set(u.id.toString(), {
        id: u.id,
        user: u,
        person,
        ready: profileReady(p),
        brief: {
          nickname: u.nickname, gender: u.gender,
          age: person.hard.birthYear ? new Date().getFullYear() - person.hard.birthYear : u.age,
          city: person.hard.city || u.cityName,
          summary: person.soft.summary, intro: person.soft.intro,
          deep: deep ? [deep.summary, ...deep.rows.map((r) => `${r.label}：${r.value}`)].join('；') : '',
        },
      });
    }
    return out;
  }

  /** 列表 / 卡片上显示的一个人：头像昵称 + 照片下面那几个小标签 */
  private brief(p: Loaded) {
    const h = p.person.hard;
    return {
      user: { id: p.id, nickname: p.user.nickname, avatar: p.user.avatar, gender: p.user.gender, age: p.brief.age, cityName: p.brief.city },
      chips: [p.brief.city, h.height ? `${h.height}cm` : '', h.education, p.person.soft.job].filter(Boolean),
    };
  }
}

/** 模型偶尔会在 JSON 外面包一层 ```，剥掉再解析 */
function parseJson(content: string): Record<string, unknown> | null {
  const text = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** AI 写的话存库前清一遍：去掉控制字符和长数字（手机号这类） */
function clean(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\d{7,}/g, '').trim() : '';
}
