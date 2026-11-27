import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 两个人之间「能不能发消息 / 打语音」「能不能视频见面」的判断，聊天、转发、通话都从这里过（服务端强制，客户端绕不过去）。
 * 写成不带依赖注入的函数，im / call / hn / match 几个模块都能直接用，不会互相绕圈引用。
 *
 * 规则（用户 2026-11-27 改的，样稿 design/09-openchat.html；之前是「互相喜欢后才能聊天」）：
 *   1. 发消息、语音通话：全部放开。不要互相喜欢、不要实人认证、不要先填完基本情况，条数不限。
 *   2. 视频见面：要两个人互相喜欢。后台有一个开关 videoNeedLike（默认开）；关掉以后没互相喜欢也能视频，测试用。
 *      （视频另外还要双方都打开「视频见面」、按后台开关要实人认证，那两条在 call.service.ts 里。）
 *   3. 任何一方点过「不合适，不再联系」→ 两边都不能再发消息、打电话。这一条任何时候都能点，是不想被打扰时唯一的办法。
 *
 * 开关只决定服务器放不放行这通视频；App 里的按钮和页面不随它变（没互相喜欢时按钮照样在，点了才提示）。
 * 之前那条「规则上线前就聊过的老聊天保留 30 天」已经用不上，去掉了；sys_setting 里旧的两项（match_legacy_days、match_rule_since）留着不读。
 */

// ---------- 后台可调的设置（存在 sys_setting 表里） ----------

export interface MatchConfig {
  /** 每天推荐几位 */
  dailyRecs: number;
  /** 在遇见 / 别人的画像里自己点喜欢，每天最多几个（每日推荐里的、回应对方喜欢的不占） */
  dailyLikes: number;
  /** 视频见面要不要互相喜欢（默认要；关掉是给测试用的，送审和正式上线时保持打开） */
  videoNeedLike: boolean;
}

const KEYS = { dailyRecs: 'match_daily_recs', dailyLikes: 'match_daily_likes', videoNeedLike: 'match_video_need_like' } as const;
const DEFAULTS = { dailyRecs: 3, dailyLikes: 3 };
const LIMITS = { dailyRecs: [1, 10], dailyLikes: [0, 50] } as const;

let cache: { at: number; cfg: MatchConfig } | null = null;
/** 设置缓存多久（毫秒）：每次打电话、每次看关系都要读，不能每次查库 */
const CACHE_MS = 30_000;

export async function getMatchConfig(prisma: PrismaService, fresh = false): Promise<MatchConfig> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.cfg;
  const rows = await prisma.sysSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof typeof DEFAULTS) => {
    const n = Number(map.get(KEYS[k]));
    return map.has(KEYS[k]) && Number.isInteger(n) && n >= LIMITS[k][0] && n <= LIMITS[k][1] ? n : DEFAULTS[k];
  };
  // 只有明确存成 '0' 才算关；没设置过、或者存了别的值，都按「要互相喜欢」
  const cfg = { dailyRecs: num('dailyRecs'), dailyLikes: num('dailyLikes'), videoNeedLike: map.get(KEYS.videoNeedLike) !== '0' };
  cache = { at: Date.now(), cfg };
  return cfg;
}

/** 后台改设置：只改传进来的那几项，数字超出范围、开关不是 true / false 直接报错 */
export async function setMatchConfig(
  prisma: PrismaService,
  patch: Partial<Record<keyof typeof DEFAULTS, unknown>> & { videoNeedLike?: unknown },
): Promise<MatchConfig> {
  for (const k of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    if (patch[k] === undefined || patch[k] === null) continue;
    const n = Number(patch[k]);
    if (!Number.isInteger(n) || n < LIMITS[k][0] || n > LIMITS[k][1]) {
      throw new HttpException(`${k} 要是 ${LIMITS[k][0]}～${LIMITS[k][1]} 之间的整数`, 400);
    }
    await prisma.sysSetting.upsert({ where: { key: KEYS[k] }, create: { key: KEYS[k], value: String(n) }, update: { value: String(n) } });
  }
  if (patch.videoNeedLike !== undefined && patch.videoNeedLike !== null) {
    if (typeof patch.videoNeedLike !== 'boolean') throw new HttpException('videoNeedLike 要是 true 或 false', 400);
    const value = patch.videoNeedLike ? '1' : '0';
    await prisma.sysSetting.upsert({ where: { key: KEYS.videoNeedLike }, create: { key: KEYS.videoNeedLike, value }, update: { value } });
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

/**
 * 客户端按这个 code 提示（WebSocket 的 error 帧和 HTTP 的 reason 都带）：
 *   need_like  = 没互相喜欢，不能视频见面（现在只有发起视频通话会收到；以前发消息也会）
 *   chat_ended = 有一方点了「不再联系」，不能发消息、不能打电话
 */
export const NEED_LIKE_CODE = 'need_like';
export const CHAT_ENDED_CODE = 'chat_ended';

export type RelationState = 'none' | 'liked' | 'likedMe' | 'mutual' | 'ended';
/** open 还没互相喜欢，照常能聊 | mutual 互相喜欢 | ended_me / ended_peer 有一方结束了联系 */
export type ChatReason = 'open' | 'mutual' | 'ended_me' | 'ended_peer';
/** ok 能视频 | need_like 还没互相喜欢（开关开着）| ended 有一方结束了联系 */
export type VideoReason = 'ok' | 'need_like' | 'ended';

export interface Relation {
  /** none 都没表态 | liked 我喜欢了、对方还没回应 | likedMe 对方先喜欢了我 | mutual 互相喜欢 | ended 有一方结束了联系 */
  state: RelationState;
  /** 我以前点过跳过 / 不合适（对方不知道；我还可以改主意点喜欢） */
  passed: boolean;
  endedBy: 'me' | 'peer' | null;
  matchedAt: Date | null;
  /** 现在能不能给对方发消息、打语音：只有一方点了「不再联系」才不能 */
  canChat: boolean;
  chatReason: ChatReason;
  /**
   * 按「互相喜欢」这一条，现在能不能视频见面（后台开关关着时，没互相喜欢也是 true）。
   * 只是这一条；双方有没有打开「视频见面」、要不要实人认证，发起通话时服务器另外查。
   */
  canVideo: boolean;
  videoReason: VideoReason;
  /** 以前「老聊天保留期」用的，现在一直是 null；留着是因为旧的安装包会读这个字段 */
  legacyUntil: null;
}

type BlockReason = 'need_like' | 'ended_me' | 'ended_peer';
const BLOCK_MSG: Record<BlockReason, string> = {
  need_like: '互相喜欢后才能视频见面',
  ended_me: '你已选择不再联系',
  ended_peer: '对方已结束聊天',
};

/** 不放行：HTTP 403，带 reason（need_like / chat_ended） */
export class ChatGateException extends HttpException {
  readonly code: string;
  constructor(reason: BlockReason) {
    const code = reason === 'need_like' ? NEED_LIKE_CODE : CHAT_ENDED_CODE;
    super({ message: BLOCK_MSG[reason], reason: code }, 403);
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

  if (mine?.kind === 'end') {
    return { ...base, state: 'ended', endedBy: 'me', canChat: false, chatReason: 'ended_me', canVideo: false, videoReason: 'ended' };
  }
  if (theirs?.kind === 'end') {
    return { ...base, state: 'ended', endedBy: 'peer', canChat: false, chatReason: 'ended_peer', canVideo: false, videoReason: 'ended' };
  }
  if (mine?.kind === 'like' && theirs?.kind === 'like') {
    return {
      ...base, state: 'mutual', matchedAt: mine.matchedAt ?? theirs.matchedAt ?? mine.updatedAt,
      canChat: true, chatReason: 'mutual', canVideo: true, videoReason: 'ok',
    };
  }
  const state: RelationState = mine?.kind === 'like' ? 'liked' : theirs?.kind === 'like' ? 'likedMe' : 'none';
  // 还没互相喜欢：消息、语音照常；视频看后台开关
  const { videoNeedLike } = await getMatchConfig(prisma);
  return { ...base, state, canChat: true, chatReason: 'open', canVideo: !videoNeedLike, videoReason: videoNeedLike ? 'need_like' : 'ok' };
}

/** 发消息、发起语音通话前调用：有一方点过「不再联系」就抛 ChatGateException（chat_ended），其余一律放行 */
export async function assertCanChat(prisma: PrismaService, me: bigint, peer: bigint): Promise<Relation> {
  const rel = await relationOf(prisma, me, peer);
  if (rel.chatReason === 'ended_me' || rel.chatReason === 'ended_peer') throw new ChatGateException(rel.chatReason);
  return rel;
}

/** 发起视频通话前调用：结束了联系抛 chat_ended；开关开着且还没互相喜欢抛 need_like */
export async function assertCanVideo(prisma: PrismaService, me: bigint, peer: bigint): Promise<Relation> {
  const rel = await assertCanChat(prisma, me, peer);
  if (!rel.canVideo) throw new ChatGateException('need_like');
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
