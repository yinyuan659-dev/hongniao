import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 视频见面按分钟收牵豆（用户 2026-11-27 定的，样稿 design/10-qiandou.html）。
 *
 * 牵豆 = 原来的「AI 余额」改了名字，1 元 = 1 牵豆；钱包、流水还是 AiWallet / AiLedger 那一套（单位微元，1 牵豆 = 1,000,000）。
 *   - 只收视频，语音和发消息不收。
 *   - 只有男方付，不管谁发起。女方不用牵豆也能打视频。
 *   - 价格后台可调（下面的 setVideoPrice），默认 0.02 牵豆 / 分钟；填 0 = 不收费。
 *     已经在打的那一通按发起时的价格算完（价格记在 call_record.price_micro 上）。
 *   - 接通时扣第 1 分钟，之后每满 1 分钟扣下一分钟；不满 1 分钟按 1 分钟，挂断不退。
 *   - 发起 / 接听前男方的牵豆不够 1 分钟：不让打。通话中扣不出下一分钟：服务器挂断。
 * 没有「默认关」的开关：收费一直是开着的，送审时审核看到的就是这个样子。
 * 计费、挂断在 call/call.service.ts；这里只有价格设置和几个算数的小函数（纯函数，好单独测）。
 */

export const MICRO = 1_000_000;

/** 客户端按这个 reason 弹「牵豆不够，去充值」（自己付、自己不够）/ 提示一句（对方付、对方不够） */
export const NO_BEANS_CODE = 'no_beans';
export const PEER_NO_BEANS_CODE = 'peer_no_beans';

const KEY = 'video_price_micro';
/** 默认 0.02 牵豆 / 分钟（我们的流量成本约 0.01 元 / 分钟） */
const DEFAULT_PRICE_MICRO = 20_000;
/** 上限 100 牵豆 / 分钟：防止后台手滑多填几个零 */
const MAX_PRICE_MICRO = 100 * MICRO;

let cache: { at: number; micro: number } | null = null;
const CACHE_MS = 30_000;

/** 现在视频每分钟收多少（微元）。0 = 不收费 */
export async function getVideoPriceMicro(prisma: PrismaService, fresh = false): Promise<number> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.micro;
  const row = await prisma.sysSetting.findUnique({ where: { key: KEY } });
  const n = Number(row?.value);
  const micro = row && Number.isInteger(n) && n >= 0 && n <= MAX_PRICE_MICRO ? n : DEFAULT_PRICE_MICRO;
  cache = { at: Date.now(), micro };
  return micro;
}

/** 后台改价：perMin 是「每分钟多少牵豆」，0～100，最多 4 位小数。改完最多 30 秒生效；正在打的通话不受影响 */
export async function setVideoPrice(prisma: PrismaService, perMin: unknown): Promise<number> {
  const micro = typeof perMin === 'number' && Number.isFinite(perMin) ? Math.round(perMin * MICRO) : NaN;
  if (!Number.isInteger(micro) || micro < 0 || micro > MAX_PRICE_MICRO || micro % 100 !== 0) {
    throw new HttpException('videoPerMin 要是 0～100 之间的数，最多 4 位小数（0 = 不收费）', 400);
  }
  await prisma.sysSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: String(micro) }, update: { value: String(micro) } });
  cache = { at: Date.now(), micro };
  return micro;
}

/** 微元 → 牵豆的写法：至少 2 位小数，最多 4 位，多余的 0 去掉。20000 → 「0.02」，1000 → 「0.001」，4980000 → 「4.98」 */
export function beans(micro: number | bigint): string {
  return (Number(micro) / MICRO).toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1');
}

/** 余额够打几分钟（价格是 0 时没有意义，返回 0） */
export function minutesAffordable(balanceMicro: number | bigint, priceMicro: number): number {
  return priceMicro > 0 ? Math.floor(Number(balanceMicro) / priceMicro) : 0;
}

/**
 * 通话进行到现在，一共应该扣到第几分钟：接通那一刻就算第 1 分钟，满 60 秒进入第 2 分钟……
 * （0 秒 → 1，59.9 秒 → 1，60 秒 → 2，125 秒 → 3）
 */
export function minutesDue(startedAt: Date, now: Date = new Date()): number {
  return Math.floor(Math.max(0, now.getTime() - startedAt.getTime()) / 60_000) + 1;
}

/** 两个人里谁付视频的牵豆：男方（gender = 1）。通话只在异性之间，所以一定有且只有一个 */
export function payerOf(a: { id: bigint; gender: number }, b: { id: bigint; gender: number }): bigint {
  return a.gender === 1 ? a.id : b.id;
}
