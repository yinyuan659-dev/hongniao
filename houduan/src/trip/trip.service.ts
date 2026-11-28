import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { WatchRegistry } from '../im/watch.registry';
import { GroupService } from '../im/group.service';
import { assertKyc } from '../common/kyc-gate';
import { TRIP_AI_PROMPT, tripAiInput } from './trip.prompt';

/**
 * 领队旅行（第 2 步，样稿 design/13-travel.html，用户 2026-11-28 过关）。
 *   1. 领队由平台在后台设置（user.isLeader）。领队发布线路，平台先审，通过了才显示，同时自动建好这条线路的群（领队是群主）。
 *   2. 「旅行」首页显示「我的领队」和他的线路：我自己是领队 → 我自己；通过某位领队的分享注册的 → 他（user.inviterId）；其余 → 后台指定的默认领队。
 *   3. 约单 = 进这条线路的群，不付钱。要做过真人认证；记一笔约单记录（之后退群不删）。
 *   4. 领队排行榜：有至少 1 条招募中线路的领队，按最近 30 天约单的人数排（同一个人对同一位领队只算 1 人，领队自己、被封的号不算），
 *      一样多的看总约单数，再一样的先成为领队的在前。
 *   5. 名额领队自己管：confirmed 是「已经定下来的人数」，页面上「还剩几位」= quota - confirmed；改名额不用审。
 *      改线路内容要重新审，审核期间用户看到的还是旧的（新内容放在 trip.pending）。
 *   6. 变化都用 WebSocket 推 { op: 'trip', data: { event, tripId?, leaderId? } }：
 *        event = trip（某条线路变了：上架 / 下架 / 内容 / 名额 / 约单数）| rank（排行榜变了）——只推给正停在旅行页面上的人（WatchRegistry）；
 *        event = review（审核结果，推给领队）| leader（被设为 / 取消领队，推给本人）。客户端收到后重新取那一页，不轮询。
 */

/** 一条线路里要审核的那些内容 */
export interface TripFields {
  title: string; videoUrl: string; coverUrl: string; startDate: string; days: number;
  gatherPlace: string; price: number; itinerary: string; feeNote: string;
}
/** 上架以后按日期算出来的：open 招募中 | departed 已出发 | ended 已结束 */
export type TripPhase = 'open' | 'departed' | 'ended';

const KEY_DEFAULT_LEADER = 'trip_default_leader';
const KEY_DEFAULT_RATE = 'referral_default_rate';
const DEFAULT_RATE = 70;
const INTRO_MAX = 60;
const DAY_MS = 86400_000;
/** 行程结束后群再留几天 */
const GROUP_KEEP_DAYS = 7;

type TripRow = Prisma.TripGetPayload<object>;
const USER_BRIEF = { id: true, nickname: true, avatar: true, gender: true, status: true, isLeader: true, leaderAt: true, leaderIntro: true } as const;
type UserBrief = Prisma.UserGetPayload<{ select: typeof USER_BRIEF }>;

/** 北京时间的今天，YYYY-MM-DD */
export function today(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}
export function phaseOf(t: { startDate: string; days: number }, day = today()): TripPhase {
  if (day < t.startDate) return 'open';
  return day <= addDays(t.startDate, t.days - 1) ? 'departed' : 'ended';
}
/** 行程结束的那一刻（最后一天过完，北京时间 24 点） */
function endAtOf(t: { startDate: string; days: number }): Date {
  return new Date(addDays(t.startDate, t.days) + 'T00:00:00+08:00');
}
/** 线路群的名字：「川西环线 12-06 团」 */
function groupNameOf(t: { title: string; startDate: string }): string {
  const head = t.title.split(/[：:，,（(\s]/)[0].slice(0, 14) || t.title.slice(0, 14);
  return `${head} ${t.startDate.slice(5)} 团`;
}
const text = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const int = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Math.floor(Number(v)) : NaN);

/** 检查领队填的内容；不对就报错，对了返回整理好的 */
export function cleanFields(dto: any, opts: { day?: string } = {}): TripFields {
  const f: TripFields = {
    title: text(dto?.title, 60), videoUrl: text(dto?.videoUrl, 255), coverUrl: text(dto?.coverUrl, 255),
    startDate: text(dto?.startDate, 10), days: int(dto?.days), gatherPlace: text(dto?.gatherPlace, 40),
    price: int(dto?.price), itinerary: text(dto?.itinerary, 2000), feeNote: text(dto?.feeNote, 1000),
  };
  if (f.title.length < 4) throw new BadRequestException('标题至少 4 个字');
  if (!/^\/res\/.+/.test(f.videoUrl)) throw new BadRequestException('请先上传带队视频');
  if (f.coverUrl && !/^\/res\/.+/.test(f.coverUrl)) throw new BadRequestException('封面不对，请重新选视频');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate) || Number.isNaN(Date.parse(f.startDate + 'T00:00:00Z'))) throw new BadRequestException('出发日期不对');
  if (f.startDate <= (opts.day ?? today())) throw new BadRequestException('出发日期要在今天之后');
  if (!(f.days >= 1 && f.days <= 60)) throw new BadRequestException('天数填 1～60');
  if (!f.gatherPlace) throw new BadRequestException('请填写集合地');
  if (!(f.price >= 0 && f.price <= 999_999)) throw new BadRequestException('价格填 0～999999 元');
  if (f.itinerary.length < 4) throw new BadRequestException('请填写行程');
  if (f.feeNote.length < 4) throw new BadRequestException('请写清楚费用包含什么、不包含什么');
  return f;
}
function cleanQuota(v: unknown): number {
  const n = int(v);
  if (!(n >= 1 && n <= 200)) throw new BadRequestException('名额填 1～200');
  return n;
}

@Injectable()
export class TripService {
  private readonly logger = new Logger('Trip');

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly registry: ConnectionRegistry,
    private readonly watch: WatchRegistry,
    private readonly groups: GroupService,
  ) {}

  // ---------- 推送 ----------

  /** 推给正停在旅行页面上的人（外加 extra 里的人） */
  private async push(event: string, data: Record<string, unknown> = {}, extra: (bigint | string)[] = []) {
    const ids = [...new Set([...this.watch.watchers('trip'), ...extra.map((x) => x.toString())])];
    if (!ids.length) return;
    try {
      await this.registry.deliver(ids, { op: 'trip', data: { event, ...data } });
    } catch (e) {
      this.logger.warn(`旅行推送失败 ${event}: ${e}`);
    }
  }
  /** 只推给指定的人 */
  private async pushTo(userIds: (bigint | string)[], event: string, data: Record<string, unknown> = {}) {
    try {
      await this.registry.deliver(userIds.map((x) => x.toString()), { op: 'trip', data: { event, ...data } });
    } catch (e) {
      this.logger.warn(`旅行推送失败 ${event}: ${e}`);
    }
  }

  // ---------- 排行榜 ----------

  /** 排行榜：从第 1 名往后排好的领队 */
  async board() {
    const day = today();
    const leaders = await this.prisma.user.findMany({ where: { isLeader: true, status: 0 }, select: USER_BRIEF });
    if (!leaders.length) return [];
    const ids = leaders.map((u) => u.id);
    const [open, recent, total] = await Promise.all([
      this.prisma.trip.groupBy({ by: ['leaderId'], where: { leaderId: { in: ids }, status: 1, startDate: { gt: day } }, _count: { _all: true } }),
      this.prisma.tripOrder.findMany({ where: { leaderId: { in: ids }, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }, select: { leaderId: true, userId: true } }),
      this.prisma.tripOrder.groupBy({ by: ['leaderId'], where: { leaderId: { in: ids } }, _count: { _all: true } }),
    ]);
    // 被封的号不算
    const buyers = [...new Set(recent.map((r) => r.userId))];
    const banned = buyers.length
      ? new Set((await this.prisma.user.findMany({ where: { id: { in: buyers }, status: { not: 0 } }, select: { id: true } })).map((u) => u.id.toString()))
      : new Set<string>();
    const people = new Map<string, Set<string>>();
    for (const r of recent) {
      if (r.userId === r.leaderId || banned.has(r.userId.toString())) continue;
      const k = r.leaderId.toString();
      if (!people.has(k)) people.set(k, new Set());
      people.get(k)!.add(r.userId.toString());
    }
    const openMap = new Map(open.map((o) => [o.leaderId.toString(), o._count._all]));
    const totalMap = new Map(total.map((o) => [o.leaderId.toString(), o._count._all]));
    return leaders
      .filter((u) => (openMap.get(u.id.toString()) ?? 0) > 0)
      .map((u) => ({
        id: u.id, nickname: u.nickname, avatar: u.avatar, intro: u.leaderIntro,
        /** 招募中的线路数 */
        trips: openMap.get(u.id.toString()) ?? 0,
        /** 最近 30 天约单的人数 */
        orders30: people.get(u.id.toString())?.size ?? 0,
        total: totalMap.get(u.id.toString()) ?? 0,
        leaderAt: u.leaderAt,
      }))
      .sort((a, b) => b.orders30 - a.orders30 || b.total - a.total
        || (a.leaderAt?.getTime() ?? Infinity) - (b.leaderAt?.getTime() ?? Infinity) || (a.id < b.id ? -1 : 1))
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }

  /** 我的领队是谁：我自己是领队 → 我；推荐我来的人是领队 → 他；否则后台指定的默认领队。没有就是 null */
  private async myLeaderId(userId: bigint): Promise<bigint | null> {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { isLeader: true, inviterId: true } });
    if (!me) throw new NotFoundException('用户不存在');
    if (me.isLeader) return userId;
    const ok = async (id: bigint | null | undefined) => {
      if (!id) return null;
      const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, isLeader: true, status: true } });
      return u && u.isLeader && u.status === 0 ? u.id : null;
    };
    return (await ok(me.inviterId)) ?? (await ok(await this.defaultLeaderId()));
  }

  private async defaultLeaderId(): Promise<bigint | null> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: KEY_DEFAULT_LEADER } });
    return row && /^\d{1,19}$/.test(row.value) ? BigInt(row.value) : null;
  }

  async defaultRate(): Promise<number> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key: KEY_DEFAULT_RATE } });
    const n = Number(row?.value);
    return row && Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_RATE;
  }

  // ---------- 给用户看的 ----------

  private async orderCounts(tripIds: bigint[]) {
    if (!tripIds.length) return new Map<string, number>();
    const rows = await this.prisma.tripOrder.groupBy({ by: ['tripId'], where: { tripId: { in: tripIds } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.tripId.toString(), r._count._all]));
  }

  private card(t: TripRow, orders: number) {
    return {
      id: t.id, leaderId: t.leaderId, title: t.title, videoUrl: t.videoUrl, coverUrl: t.coverUrl,
      startDate: t.startDate, days: t.days, gatherPlace: t.gatherPlace, price: t.price,
      quota: t.quota, left: Math.max(t.quota - t.confirmed, 0),
      /** 几人已约单 */
      orders,
      phase: phaseOf(t),
    };
  }

  /** 一位领队正在招募的线路（早出发的在前） */
  private async openTrips(leaderId: bigint) {
    const trips = await this.prisma.trip.findMany({ where: { leaderId, status: 1, startDate: { gt: today() } }, orderBy: [{ startDate: 'asc' }, { id: 'asc' }] });
    const counts = await this.orderCounts(trips.map((t) => t.id));
    return trips.map((t) => this.card(t, counts.get(t.id.toString()) ?? 0));
  }

  private leaderView(u: UserBrief, board: Awaited<ReturnType<TripService['board']>>) {
    const row = board.find((b) => b.id === u.id);
    return {
      id: u.id, nickname: u.nickname, avatar: u.avatar, intro: u.leaderIntro,
      /** 排行榜第几名；没上榜（没有招募中的线路）是 null */
      rank: row?.rank ?? null,
      orders30: row?.orders30 ?? 0,
      trips: row?.trips ?? 0,
    };
  }

  /** 大厅「旅行」首页：我的领队 + 他的线路 + 排行榜前三名的头像 */
  async home(userId: bigint) {
    const [leaderId, board] = await Promise.all([this.myLeaderId(userId), this.board()]);
    const u = leaderId ? await this.prisma.user.findUnique({ where: { id: leaderId }, select: USER_BRIEF }) : null;
    return {
      leader: u ? { ...this.leaderView(u, board), self: u.id === userId } : null,
      trips: u ? await this.openTrips(u.id) : [],
      top: board.slice(0, 3).map((b) => ({ id: b.id, nickname: b.nickname, avatar: b.avatar })),
      /** 榜上一共几位领队（0 = 入口不显示） */
      leaders: board.length,
    };
  }

  /** 领队排行榜 */
  async leaderboard(userId: bigint) {
    const [mine, board] = await Promise.all([this.myLeaderId(userId), this.board()]);
    return board.map((b) => ({
      rank: b.rank, id: b.id, nickname: b.nickname, avatar: b.avatar, intro: b.intro, trips: b.trips, orders30: b.orders30,
      /** 是不是「我的领队」 */
      mine: mine !== null && b.id === mine,
    }));
  }

  /** 领队页 */
  async leaderPage(userId: bigint, leaderId: bigint) {
    const u = await this.prisma.user.findUnique({ where: { id: leaderId }, select: USER_BRIEF });
    if (!u || !u.isLeader || u.status !== 0) throw new NotFoundException('没有这位领队');
    const [mine, board] = await Promise.all([this.myLeaderId(userId), this.board()]);
    return { leader: { ...this.leaderView(u, board), self: u.id === userId, mine: mine === u.id }, trips: await this.openTrips(u.id) };
  }

  private async mustTrip(tripId: bigint) {
    const t = await this.prisma.trip.findUnique({ where: { id: tripId } });
    if (!t) throw new NotFoundException('没有这条线路');
    return t;
  }

  /**
   * 线路详情。上架了的谁都能看；没上架的只有领队自己能看。
   * btn 是底下那个按钮的样子：order 约单 | joined 进入群聊 | owner 我是领队 | full 名额已满 | departed 已出发 | ended 已结束 | blocked 不能约单 | off 没上架
   */
  async detail(userId: bigint, tripId: bigint) {
    const t = await this.mustTrip(tripId);
    const owner = t.leaderId === userId;
    if (t.status !== 1 && !owner) throw new NotFoundException('这条线路不在了');
    const [leader, board, counts, recent] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: t.leaderId }, select: USER_BRIEF }),
      this.board(),
      this.orderCounts([t.id]),
      this.prisma.tripOrder.findMany({ where: { tripId }, orderBy: { id: 'desc' }, take: 3, select: { userId: true } }),
    ]);
    if (!leader) throw new NotFoundException('这条线路不在了');
    const faces = recent.length
      ? await this.prisma.user.findMany({ where: { id: { in: recent.map((r) => r.userId) } }, select: { id: true, avatar: true } })
      : [];
    const member = t.groupId ? await this.groups.member(t.groupId, userId) : null;
    const conv = t.groupId ? await this.prisma.conversation.findUnique({ where: { groupId: t.groupId }, select: { id: true } }) : null;
    const card = this.card(t, counts.get(t.id.toString()) ?? 0);
    const btn = t.status !== 1 ? 'off'
      : owner ? 'owner'
      : member?.status === 0 ? 'joined'
      : member && member.status >= 2 ? 'blocked'
      : card.phase !== 'open' ? card.phase
      : card.left <= 0 ? 'full' : 'order';
    return {
      ...card, itinerary: t.itinerary, feeNote: t.feeNote, status: t.status,
      leader: this.leaderView(leader, board),
      /** 最近约单的几个人的头像 */
      faces: recent.map((r) => faces.find((f) => f.id === r.userId)?.avatar ?? ''),
      btn,
      /** 我在群里（或者我是领队）才给：点了直接进群 */
      group: t.groupId && conv && (owner || member?.status === 0) ? { id: t.groupId, conversationId: conv.id, name: groupNameOf(t) } : null,
    };
  }

  /** 约单 = 进这条线路的群。要做过真人认证；记一笔约单记录 */
  async order(userId: bigint, tripId: bigint) {
    const t = await this.mustTrip(tripId);
    if (t.status !== 1 || !t.groupId) throw new BadRequestException('这条线路不在了');
    if (t.leaderId === userId) throw new BadRequestException('这是你自己的线路');
    await assertKyc(this.prisma, userId);
    const member = await this.groups.member(t.groupId, userId);
    if (member?.status !== 0) {
      if (member && member.status >= 2) throw new ForbiddenException('你已被移出这条线路的群，不能再约单');
      if (phaseOf(t) !== 'open') throw new BadRequestException('这条线路已经出发了');
      if (t.confirmed >= t.quota) throw new BadRequestException('名额已满');
    }
    const view = await this.groups.systemJoin(userId, t.groupId);
    const existed = await this.prisma.tripOrder.findUnique({ where: { tripId_userId: { tripId, userId } }, select: { id: true } });
    if (!existed) {
      await this.prisma.tripOrder.create({ data: { tripId, userId, leaderId: t.leaderId } }).catch(() => undefined);
      await this.push('trip', { tripId: tripId.toString(), leaderId: t.leaderId.toString() }, [t.leaderId]);
      await this.push('rank');
    }
    return { groupId: view.id, conversationId: view.conversationId, name: view.name };
  }

  // ---------- 领队后台 ----------

  private async assertLeader(userId: bigint) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.status !== 0) throw new ForbiddenException('账号异常');
    if (!u.isLeader) throw new ForbiddenException('只有领队可以操作');
    return u;
  }

  private async ownTrip(userId: bigint, tripId: bigint) {
    await this.assertLeader(userId);
    const t = await this.mustTrip(tripId);
    if (t.leaderId !== userId) throw new ForbiddenException('这不是你的线路');
    return t;
  }

  /** 领队后台首页：四个数、我的介绍、我的线路（全部状态） */
  async mine(userId: bigint) {
    const u = await this.assertLeader(userId);
    const [board, invited, trips, rate] = await Promise.all([
      this.board(),
      this.prisma.user.count({ where: { inviterId: userId } }),
      this.prisma.trip.findMany({ where: { leaderId: userId }, orderBy: { id: 'desc' }, take: 100 }),
      this.defaultRate(),
    ]);
    const row = board.find((b) => b.id === userId);
    const counts = await this.orderCounts(trips.map((t) => t.id));
    // 没上榜（没有招募中的线路）时，约单人数单独数一下
    const orders30 = row?.orders30 ?? new Set(
      (await this.prisma.tripOrder.findMany({ where: { leaderId: userId, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) }, userId: { not: userId } }, select: { userId: true } }))
        .map((r) => r.userId.toString()),
    ).size;
    return {
      rank: row?.rank ?? null, orders30, invited,
      /** 推荐奖励比例（百分数）：单独设过的用单独的，没设过用默认的 */
      rate: u.referralRate ?? rate,
      intro: u.leaderIntro,
      /** 改了、还在等审核的介绍；没有是 null */
      introPending: u.leaderIntroPending,
      trips: trips.map((t) => ({
        ...this.card(t, counts.get(t.id.toString()) ?? 0), confirmed: t.confirmed,
        /** reviewing 审核中 | open 招募中 | departed 已出发 | ended 已结束 | rejected 没通过 | off 已下架 */
        state: t.status === 0 ? 'reviewing' : t.status === 1 ? phaseOf(t) : t.status === 2 ? 'rejected' : 'off',
        rejectReason: t.rejectReason,
        /** 上架以后又改了内容、在等审核 */
        hasPending: t.pending !== null,
      })),
    };
  }

  /** 发布线路：先审后发 */
  async create(userId: bigint, dto: any) {
    await this.assertLeader(userId);
    const f = cleanFields(dto);
    const quota = cleanQuota(dto?.quota);
    const t = await this.prisma.trip.create({ data: { leaderId: userId, ...f, quota } });
    this.logger.log(`线路提交审核: trip=${t.id} leader=${userId}`);
    return { id: t.id, status: t.status };
  }

  /**
   * 改线路内容：
   *   审核中 / 没通过的：直接改，重新排队审核；
   *   已上架、还没出发的：新内容先放在 pending，审核通过了才换上去（用户这期间看到的还是旧的）。
   */
  async update(userId: bigint, tripId: bigint, dto: any) {
    const t = await this.ownTrip(userId, tripId);
    const f = cleanFields(dto);
    if (t.status === 0 || t.status === 2) {
      await this.prisma.trip.update({ where: { id: tripId }, data: { ...f, ...(dto?.quota !== undefined ? { quota: cleanQuota(dto.quota) } : {}), status: 0, rejectReason: '', submittedAt: new Date() } });
      return { id: tripId, status: 0, pending: false };
    }
    if (t.status !== 1) throw new BadRequestException('已经下架的线路不能改，重新发布一条');
    if (phaseOf(t) !== 'open') throw new BadRequestException('已经出发的线路不能改');
    await this.prisma.trip.update({ where: { id: tripId }, data: { pending: f as unknown as Prisma.InputJsonValue, pendingAt: new Date(), rejectReason: '' } });
    return { id: tripId, status: 1, pending: true };
  }

  /** 改名额：总名额、已经定下来的人数。不用审核，马上生效 */
  async setQuota(userId: bigint, tripId: bigint, dto: { quota?: unknown; confirmed?: unknown }) {
    const t = await this.ownTrip(userId, tripId);
    if (t.status !== 1) throw new BadRequestException('上架以后才能改名额');
    const quota = dto?.quota !== undefined && dto.quota !== null ? cleanQuota(dto.quota) : t.quota;
    const confirmed = dto?.confirmed !== undefined && dto.confirmed !== null ? int(dto.confirmed) : Math.min(t.confirmed, quota);
    if (!(confirmed >= 0 && confirmed <= quota)) throw new BadRequestException(`已经定下来的人数填 0～${quota}`);
    await this.prisma.trip.update({ where: { id: tripId }, data: { quota, confirmed } });
    await this.push('trip', { tripId: tripId.toString(), leaderId: userId.toString() }, [userId]);
    return { quota, confirmed, left: quota - confirmed };
  }

  /** 领队下架：没上架的直接撤回；上架了、还没出发的下架并解散线路群；出发以后不能下架 */
  async off(userId: bigint, tripId: bigint) {
    const t = await this.ownTrip(userId, tripId);
    if (t.status >= 3) return { ok: true };
    if (t.status === 1 && phaseOf(t) !== 'open') throw new BadRequestException('已经出发的线路不能下架');
    await this.takeDown(t, 3);
    return { ok: true };
  }

  /** 下架一条线路（how：3 领队下架 4 平台下架），线路群跟着解散 */
  private async takeDown(t: TripRow, how: 3 | 4) {
    const listed = t.status === 1;
    await this.prisma.trip.update({ where: { id: t.id }, data: { status: how, pending: Prisma.DbNull, pendingAt: null } });
    if (listed && t.groupId) await this.groups.systemDissolve(t.groupId, 'cancel').catch((e) => this.logger.warn(`解散线路群出错 ${t.groupId}: ${e}`));
    if (listed) {
      await this.push('trip', { tripId: t.id.toString(), leaderId: t.leaderId.toString() }, [t.leaderId]);
      await this.push('rank');
    }
  }

  /** 约单的人（领队看）：头像、昵称、什么时候约的、现在还在不在群里 */
  async orders(userId: bigint, tripId: bigint) {
    const t = await this.ownTrip(userId, tripId);
    const rows = await this.prisma.tripOrder.findMany({ where: { tripId }, orderBy: { id: 'desc' }, take: 300 });
    const ids = rows.map((r) => r.userId);
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, nickname: true, avatar: true, gender: true } })
      : [];
    const members = ids.length && t.groupId
      ? await this.prisma.groupMember.findMany({ where: { groupId: t.groupId, userId: { in: ids } }, select: { userId: true, status: true } })
      : [];
    const umap = new Map<string, (typeof users)[number]>(users.map((u) => [u.id.toString(), u]));
    const mmap = new Map<string, number>(members.map((m) => [m.userId.toString(), m.status]));
    return rows.map((r) => ({
      ...(umap.get(r.userId.toString()) ?? { id: r.userId, nickname: '', avatar: '', gender: 0 }),
      at: r.createdAt,
      /** 现在还在不在线路群里 */
      inGroup: mmap.get(r.userId.toString()) === 0,
    }));
  }

  /** 改一句话介绍：先存着等平台审核，通过了才显示 */
  async setIntro(userId: bigint, raw: unknown) {
    const u = await this.assertLeader(userId);
    const intro = text(raw, 200);
    if (intro.length > INTRO_MAX) throw new BadRequestException(`介绍最多 ${INTRO_MAX} 个字`);
    const pending = intro === u.leaderIntro ? null : intro;
    await this.prisma.user.update({ where: { id: userId }, data: { leaderIntroPending: pending } });
    return { intro: u.leaderIntro, introPending: pending };
  }

  /**
   * 发布线路时和 AI 聊：领队说一句，AI 认出各项，差什么问什么。费用从领队自己的牵豆里扣（走 AiGatewayService）。
   * draft 是到现在为止认出来的；返回合并以后的 draft、还差哪几项、AI 回的那句话。
   * 没有牵豆也没填 Key 时网关会抛 AiPayException（402 + reason），客户端改成表单自己填。
   */
  async ai(userId: bigint, body: { text?: unknown; draft?: unknown }) {
    await this.assertLeader(userId);
    const said = text(body?.text, 600);
    if (!said) throw new BadRequestException('说点什么');
    const draft = pickDraft(body?.draft);
    const r = await this.gateway.chat({
      userId, feature: 'trip', groupKey: `trip:${today()}`, json: true, maxTokens: 500, temperature: 0.2,
      messages: [
        { role: 'system', content: TRIP_AI_PROMPT },
        { role: 'user', content: tripAiInput(draft, said, today()) },
      ],
    });
    let got: any = {};
    try { got = JSON.parse(r.content); } catch { got = {}; }
    const next = pickDraft({ ...draft, ...Object.fromEntries(Object.entries(pickDraft(got)).filter(([, v]) => v !== null)) });
    const LABELS: Record<string, string> = { title: '标题', startDate: '出发日期', days: '天数', gatherPlace: '集合地', price: '价格', quota: '名额', itinerary: '行程', feeNote: '费用包含什么、不含什么' };
    const missing = Object.keys(LABELS).filter((k) => (next as any)[k] === null);
    const reply = text(got?.reply, 200) || (missing.length ? `还差：${missing.map((k) => LABELS[k]).join('、')}。` : '都齐了，看看对不对。对了就点「提交审核」。');
    return { draft: next, missing, reply, payMode: r.payMode };
  }

  // ---------- 后台 ----------

  /** 设为 / 取消领队。取消时：他上架中的线路全部下架（线路群解散），审核中的退回；推荐关系、比例不变 */
  async adminSetLeader(userId: bigint, on: boolean) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new NotFoundException('用户不存在');
    let offTrips = 0;
    if (on) {
      if (!u.isLeader) await this.prisma.user.update({ where: { id: userId }, data: { isLeader: true, leaderAt: new Date() } });
    } else if (u.isLeader) {
      const trips = await this.prisma.trip.findMany({ where: { leaderId: userId, status: { in: [0, 1] } } });
      for (const t of trips) {
        if (t.status === 0) await this.prisma.trip.update({ where: { id: t.id }, data: { status: 2, rejectReason: '已经不是领队' } });
        else if (phaseOf(t) === 'ended') continue;
        else { await this.takeDown(t, 4); offTrips++; }
      }
      await this.prisma.user.update({ where: { id: userId }, data: { isLeader: false, leaderIntroPending: null } });
      if ((await this.defaultLeaderId()) === userId) await this.prisma.sysSetting.deleteMany({ where: { key: KEY_DEFAULT_LEADER } });
    }
    await this.pushTo([userId], 'leader', { on });
    await this.push('rank');
    return { isLeader: on, offTrips };
  }

  /** 返佣比例：0～100 的整数；null = 恢复成默认的 */
  async adminSetRate(userId: bigint, rate: unknown) {
    const n = rate === null || rate === undefined || rate === '' ? null : int(rate);
    if (n !== null && !(n >= 0 && n <= 100)) throw new BadRequestException('比例填 0～100 的整数');
    const u = await this.prisma.user.update({ where: { id: userId }, data: { referralRate: n }, select: { id: true, referralRate: true } }).catch(() => null);
    if (!u) throw new NotFoundException('用户不存在');
    return { referralRate: u.referralRate, rate: u.referralRate ?? (await this.defaultRate()) };
  }

  async adminConfig() {
    const id = await this.defaultLeaderId();
    const u = id ? await this.prisma.user.findUnique({ where: { id }, select: { id: true, shortId: true, nickname: true, isLeader: true } }) : null;
    return { defaultLeader: u && u.isLeader ? u : null, defaultRate: await this.defaultRate() };
  }

  /** 改设置：defaultLeader 传用户 id（空 = 不指定）；defaultRate 0～100 */
  async adminSetConfig(dto: { defaultLeader?: unknown; defaultRate?: unknown }) {
    if (dto?.defaultLeader !== undefined) {
      const raw = String(dto.defaultLeader ?? '').trim();
      if (!raw) {
        await this.prisma.sysSetting.deleteMany({ where: { key: KEY_DEFAULT_LEADER } });
      } else {
        if (!/^\d{1,19}$/.test(raw)) throw new BadRequestException('用户 id 不对');
        const u = await this.prisma.user.findUnique({ where: { id: BigInt(raw) }, select: { isLeader: true, status: true } });
        if (!u || !u.isLeader || u.status !== 0) throw new BadRequestException('只能指定一位正常的领队');
        await this.prisma.sysSetting.upsert({ where: { key: KEY_DEFAULT_LEADER }, create: { key: KEY_DEFAULT_LEADER, value: raw }, update: { value: raw } });
      }
    }
    if (dto?.defaultRate !== undefined) {
      const n = int(dto.defaultRate);
      if (!(n >= 0 && n <= 100)) throw new BadRequestException('默认比例填 0～100 的整数');
      await this.prisma.sysSetting.upsert({ where: { key: KEY_DEFAULT_RATE }, create: { key: KEY_DEFAULT_RATE, value: String(n) }, update: { value: String(n) } });
    }
    return this.adminConfig();
  }

  /**
   * 线路列表。cat = review 等审核的（新发布的 + 上架后改过内容的）| on 上架中 | rejected 没通过 | off 已下架 | all。
   * 另带 intros：领队改了、等审核的一句话介绍。
   */
  async adminTrips(cat?: string, page = 1, size = 20) {
    const CATS: Record<string, Prisma.TripWhereInput> = {
      review: { OR: [{ status: 0 }, { status: 1, pendingAt: { not: null } }] },
      on: { status: 1 }, rejected: { status: 2 }, off: { status: { in: [3, 4] } }, all: {},
    };
    const c = cat && CATS[cat] ? cat : 'review';
    size = Math.min(Math.max(Math.floor(size) || 20, 10), 100);
    page = Math.max(Math.floor(page) || 1, 1);
    const [total, counts, trips, intros] = await Promise.all([
      this.prisma.trip.count({ where: CATS[c] }),
      Promise.all(Object.entries(CATS).map(async ([k, w]) => [k, await this.prisma.trip.count({ where: w })] as const)).then(Object.fromEntries),
      this.prisma.trip.findMany({ where: CATS[c], orderBy: c === 'review' ? { submittedAt: 'asc' } : { id: 'desc' }, skip: (page - 1) * size, take: size }),
      this.prisma.user.findMany({ where: { isLeader: true, leaderIntroPending: { not: null } }, select: { id: true, shortId: true, nickname: true, avatar: true, leaderIntro: true, leaderIntroPending: true } }),
    ]);
    const leaders = trips.length
      ? await this.prisma.user.findMany({ where: { id: { in: trips.map((t) => t.leaderId) } }, select: { id: true, shortId: true, nickname: true, avatar: true } })
      : [];
    const lmap = new Map(leaders.map((l) => [l.id.toString(), l]));
    const ocount = await this.orderCounts(trips.map((t) => t.id));
    return {
      total, page, size, counts, intros,
      list: trips.map((t) => ({ ...t, leader: lmap.get(t.leaderId.toString()) ?? null, orders: ocount.get(t.id.toString()) ?? 0, phase: t.status === 1 ? phaseOf(t) : null })),
    };
  }

  /**
   * 审一条线路。新发布的：通过 → 上架、建群；不通过 → 退回，带原因。
   * 上架后改过内容的：通过 → 新内容换上去（群的名字、封面、解散时间跟着改）；不通过 → 新内容丢掉，线路照旧，原因给领队看。
   */
  async adminReview(tripId: bigint, pass: boolean, reason?: unknown) {
    const t = await this.mustTrip(tripId);
    const why = text(reason, 200);
    if (!pass && !why) throw new BadRequestException('不通过要写原因');
    if (t.status === 0) {
      if (!pass) {
        await this.prisma.trip.update({ where: { id: tripId }, data: { status: 2, rejectReason: why, reviewedAt: new Date() } });
      } else {
        if (t.startDate <= today()) throw new BadRequestException('出发日期已经过了，让领队改了再提交');
        const leader = await this.prisma.user.findUnique({ where: { id: t.leaderId }, select: { isLeader: true, status: true } });
        if (!leader?.isLeader || leader.status !== 0) throw new BadRequestException('发布的人已经不是领队了');
        const endAt = endAtOf(t);
        const g = await this.groups.createSystemGroup({
          ownerId: t.leaderId, name: groupNameOf(t), kind: 'trip', refId: t.id, avatar: t.coverUrl,
          endAt, expireAt: new Date(endAt.getTime() + GROUP_KEEP_DAYS * DAY_MS),
        });
        await this.prisma.trip.update({ where: { id: tripId }, data: { status: 1, rejectReason: '', reviewedAt: new Date(), groupId: BigInt(g.id) } });
        await this.push('trip', { tripId: tripId.toString(), leaderId: t.leaderId.toString() });
        await this.push('rank');
      }
    } else if (t.status === 1 && t.pending !== null) {
      if (!pass) {
        await this.prisma.trip.update({ where: { id: tripId }, data: { pending: Prisma.DbNull, pendingAt: null, rejectReason: why, reviewedAt: new Date() } });
      } else {
        const f = cleanFields(t.pending, { day: '0000-00-00' });
        if (phaseOf(t) !== 'open' || f.startDate <= today()) throw new BadRequestException('线路已经出发、或者新的出发日期已经过了，不能通过');
        const next = await this.prisma.trip.update({ where: { id: tripId }, data: { ...f, pending: Prisma.DbNull, pendingAt: null, rejectReason: '', reviewedAt: new Date() } });
        if (next.groupId) {
          const endAt = endAtOf(next);
          await this.groups.setSchedule(next.groupId, endAt, new Date(endAt.getTime() + GROUP_KEEP_DAYS * DAY_MS)).catch(() => undefined);
          await this.prisma.chatGroup.update({ where: { id: next.groupId }, data: { avatar: next.coverUrl } }).catch(() => undefined);
          if (groupNameOf(next) !== groupNameOf(t)) await this.groups.update(next.leaderId, next.groupId, { name: groupNameOf(next) }).catch(() => undefined);
        }
        await this.push('trip', { tripId: tripId.toString(), leaderId: t.leaderId.toString() });
      }
    } else {
      throw new BadRequestException('这条线路现在没有要审的内容');
    }
    await this.pushTo([t.leaderId], 'review', { tripId: tripId.toString(), pass });
    this.logger.log(`线路审核: trip=${tripId} ${pass ? '通过' : '不通过'}`);
    return { ok: true, pass };
  }

  /** 审领队改的一句话介绍 */
  async adminReviewIntro(userId: bigint, pass: boolean) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { leaderIntroPending: true } });
    if (!u || u.leaderIntroPending === null) throw new BadRequestException('没有要审的介绍');
    await this.prisma.user.update({ where: { id: userId }, data: { leaderIntroPending: null, ...(pass ? { leaderIntro: u.leaderIntroPending } : {}) } });
    await this.pushTo([userId], 'review', { intro: true, pass });
    if (pass) await this.push('rank');
    return { ok: true, pass };
  }

  /** 平台下架一条线路（违规时用）：线路群跟着解散 */
  async adminOff(tripId: bigint) {
    const t = await this.mustTrip(tripId);
    if (t.status >= 3) return { ok: true };
    await this.takeDown(t, 4);
    await this.pushTo([t.leaderId], 'review', { tripId: tripId.toString(), pass: false, off: true });
    return { ok: true };
  }

  /** 彻底删掉一条线路（只给自测用：标题以【自测】开头的才能删）：约单记录、线路群一起删 */
  async adminDeleteTest(tripId: bigint) {
    const t = await this.mustTrip(tripId);
    if (!t.title.startsWith('【自测】')) throw new ForbiddenException('只能删除标题以【自测】开头的线路');
    if (t.groupId) {
      await this.prisma.chatGroup.update({ where: { id: t.groupId }, data: { kind: 'test' } }).catch(() => undefined);
      await this.groups.adminDeleteTest(t.groupId).catch((e) => this.logger.warn(`删线路群出错 ${t.groupId}: ${e}`));
    }
    await this.prisma.tripOrder.deleteMany({ where: { tripId } });
    await this.prisma.trip.delete({ where: { id: tripId } });
    await this.push('rank');
    return { ok: true };
  }
}

/** 和 AI 聊出来的草稿：认出来的填上，没认出来的是 null */
function pickDraft(raw: any) {
  const s = (v: unknown, max: number) => { const x = text(v, max); return x ? x : null; };
  const n = (v: unknown, lo: number, hi: number) => { const x = int(v); return x >= lo && x <= hi ? x : null; };
  const date = s(raw?.startDate, 10);
  return {
    title: s(raw?.title, 60),
    startDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    days: n(raw?.days, 1, 60),
    gatherPlace: s(raw?.gatherPlace, 40),
    price: n(raw?.price, 0, 999_999),
    quota: n(raw?.quota, 1, 200),
    itinerary: s(raw?.itinerary, 2000),
    feeNote: s(raw?.feeNote, 1000),
  };
}
