import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 「互相喜欢后才能聊天」的判断，聊天、转发、通话都从这里过（服务端强制，客户端绕不过去）。
 * 写成不带依赖注入的函数，im / call / hn / match 几个模块都能直接用，不会互相绕圈引用。
 *
 * 规则（用户 2026-11-23 定的）：
 *   1. 两个人互相喜欢了 → 能聊。
 *   2. 任何一方点过「不合适，不再联系」→ 两边都不能再发。
 *   3. 这条规则上线前就聊过的人 → 保留一段时间（默认 30 天，后台可调）照常能聊；
 *      到期还没互相喜欢的不能再发新消息，聊天记录还能看。
 *   4. 其余情况一律不能发。
 */

// ---------- 后台可调的设置（存在 sys_setting 表里） ----------

export interface MatchConfig {
  /** 每天推荐几位 */
  dailyRecs: number;
  /** 在遇见 / 别人的画像里自己点喜欢，每天最多几个（每日推荐里的、回应对方喜欢的不占） */
  dailyLikes: number;
  /** 规则上线前就有的聊天保留多少天 */
  legacyDays: number;
  /** 规则上线的时间：第一次用到时自动记下，之后不变 */
  since: Date;
}

const KEYS = { dailyRecs: 'match_daily_recs', dailyLikes: 'match_daily_likes', legacyDays: 'match_legacy_days', since: 'match_rule_since' } as const;
const DEFAULTS = { dailyRecs: 3, dailyLikes: 3, legacyDays: 30 };
const LIMITS = { dailyRecs: [1, 10], dailyLikes: [0, 50], legacyDays: [0, 365] } as const;

let cache: { at: number; cfg: MatchConfig } | null = null;
/** 设置缓存多久（毫秒）：每发一条消息都要读，不能每次查库 */
const CACHE_MS = 30_000;

export async function getMatchConfig(prisma: PrismaService, fresh = false): Promise<MatchConfig> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const rows = await prisma.sysSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof typeof DEFAULTS) => {
    const n = Number(map.get(KEYS[k]));
    return map.has(KEYS[k]) && Number.isInteger(n) && n >= LIMITS[k][0] && n <= LIMITS[k][1] ? n : DEFAULTS[k];
  };
  let since = new Date(map.get(KEYS.since) ?? '');
  if (Number.isNaN(since.getTime())) {
    // 第一次：把现在记成规则上线的时间。两个请求同时到也只会记下先写进去的那个
    since = new Date();
    await prisma.sysSetting.upsert({ where: { key: KEYS.since }, create: { key: KEYS.since, value: since.toISOString() }, update: {} });
    const saved = await prisma.sysSetting.findUnique({ where: { key: KEYS.since } });
    const d = new Date(saved?.value ?? '');
    if (!Number.isNaN(d.getTime())) since = d;
  }
  const cfg = { dailyRecs: num('dailyRecs'), dailyLikes: num('dailyLikes'), legacyDays: num('legacyDays'), since };
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** 后台改设置：只改传进来的那几项，数字超出范围直接报错 */
export async function setMatchConfig(prisma: PrismaService, patch: Partial<Record<keyof typeof DEFAULTS, unknown>>): Promise<MatchConfig> {
  for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    if (patch[k] === undefined || patch[k] === null) continue;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < LIMITS[k][0] || n > LIMITS[k][1]) {
      throw new HttpException(`${k} 要是 ${LIMITS[k][0]}～${LIMITS[k][1]} 之间的整数`, 400);
    }
    await prisma.sysSetting.upsert({ where: { key: KEYS[k] }, create: { key: KEYS[k], value: String(n) }, update: { value: String(n) } });
  }
  return getMatchConfig(prisma, true);
}

// ---------- 推荐日：北京时间上午 10 点换日 ----------

const BJ = 8 * 3600_000;
const SWITCH_HOUR = 10;

/** 现在算哪一个推荐日，例如 '2026-11-23'（上午 10 点之前算前一天） */
export function recDay(now: Date = new Date()): string {
  return new Date(now.getTime() + BJ - SWITCH_HOUR * 3600_000).toISOString().slice(0, 10);
}

/** 下一次换日的时间（下一个北京时间上午 10 点） */
export function nextRecAt(now: Date = new Date()): Date {
  const start = new Date(`${recDay(now)}T00:00:00.000Z`).getTime() - BJ + SWITCH_HOUR * 3600_000;
  return new Date(start + 86400_000);
}

// ---------- 两个人的关系 ----------

/** 客户端按这个 code 提示「互相喜欢后才能聊」/「对方已结束聊天」（WebSocket 的 error 帧和 HTTP 的 reason 都带） */
export const NEED_LIKE_CODE = 'need_like';
export const CHAT_ENDED_CODE = 'chat_ended';

export type RelationState = 'none' | 'liked' | 'likedMe' | 'mutual' | 'ended';
export type ChatReason = 'mutual' | 'legacy' | 'need_like' | 'legacy_expired' | 'ended_me' | 'ended_peer';

export interface Relation {
  /** none 都没表态 | liked 我喜欢了、对方还没回应 | likedMe 对方先喜欢了我 | mutual 互相喜欢 | ended 有一方结束了联系 */
  state: RelationState;
  /** 我以前点过跳过 / 不合适（对方不知道；我还可以改主意点喜欢） */
  passed: boolean;
  endedBy: 'me' | 'peer' | null;
  matchedAt: Date | null;
  /** 现在能不能给对方发消息、打电话 */
  canChat: boolean;
  chatReason: ChatReason;
  /** 老聊天的保留期到哪一天（只有 chatReason 是 legacy / legacy_expired 时有） */
  legacyUntil: Date | null;
}

const CHAT_MSG: Record<ChatReason, string> = {
  mutual: '',
  legacy: '',
  need_like: '互相喜欢后才能聊天',
  legacy_expired: '互相喜欢后才能继续聊',
  ended_me: '你已选择不再联系',
  ended_peer: '对方已结束聊天',
};

/** 不能聊：HTTP 403，带 reason（need_like / chat_ended） */
export class ChatGateException extends HttpException {
  readonly code: string;
  constructor(reason: ChatReason) {
    const code = reason === 'ended_me' || reason === 'ended_peer' ? CHAT_ENDED_CODE : NEED_LIKE_CODE;
    super({ message: CHAT_MSG[reason], reason: code }, 403);
    this.code = code;
  }
}

export async function relationOf(prisma: PrismaService, me: bigint, peer: bigint): Promise<Relation> {
  const rows = await prisma.matchAction.findMany({
    where: { OR: [{ userId: me, targetId: peer }, { userId: peer, targetId: me }] },
  });
  const mine = rows.find((r) => r.userId === me);
  const theirs = rows.find((r) => r.userId === peer);
  const base = { passed: mine?.kind === 'pass', endedBy: null, matchedAt: null, legacyUntil: null } as const;

  if (mine?.kind === 'end') return { ...base, state: 'ended', endedBy: 'me', canChat: false, chatReason: 'ended_me' };
  if (theirs?.kind === 'end') return { ...base, state: 'ended', endedBy: 'peer', canChat: false, chatReason: 'ended_peer' };
  if (mine?.kind === 'like' && theirs?.kind === 'like') {
    return { ...base, state: 'mutual', matchedAt: mine.matchedAt ?? theirs.matchedAt ?? mine.updatedAt, canChat: true, chatReason: 'mutual' };
  }
  const state: RelationState = mine?.kind === 'like' ? 'liked' : theirs?.kind === 'like' ? 'likedMe' : 'none';

  // 还没互相喜欢：看是不是规则上线前就聊过的老聊天
  const cfg = await getMatchConfig(prisma);
  const [min, max] = me < peer ? [me, peer] : [peer, me];
  const conv = await prisma.conversation.findUnique({ where: { pairKey: `${min}_${max}` }, select: { id: true } });
  const first = conv
    ? await prisma.message.findFirst({ where: { conversationId: conv.id }, orderBy: { id: 'asc' }, select: { createdAt: true } })
    : null;
  if (first && first.createdAt < cfg.since) {
    const until = new Date(cfg.since.getTime() + cfg.legacyDays * 86400_000);
    return Date.now() < until.getTime()
      ? { ...base, state, canChat: true, chatReason: 'legacy', legacyUntil: until }
      : { ...base, state, canChat: false, chatReason: 'legacy_expired', legacyUntil: until };
  }
  return { ...base, state, canChat: false, chatReason: 'need_like' };
}

/** 发消息 / 发起通话前调用：不能聊就抛 ChatGateException */
export async function assertCanChat(prisma: PrismaService, me: bigint, peer: bigint): Promise<Relation> {
  const rel = await relationOf(prisma, me, peer);
  if (!rel.canChat) throw new ChatGateException(rel.chatReason);
  return rel;
}

/**
 * 基本情况填完了没有：点选问答确认过，并且彩礼、彩礼怎么给、要孩子的前提三题都答了。
 * 没填完的人不能点喜欢、不会被推荐（这三题是推荐的硬条件，缺了没法判断两边对不对得上）。
 */
export function profileReady(row: { confirmedAt: Date | null; hard: unknown } | null | undefined): boolean {
  if (!row?.confirmedAt) return false;
  const h = (row.hard ?? {}) as Record<string, unknown>;
  return !!h.bride && !!h.bridePay && !!h.kidsBefore;
}
