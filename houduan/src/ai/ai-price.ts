/**
 * 模型价格和计费规则。
 *
 * 用户用「平台余额」时：扣 DeepSeek 实际费用 + 10% 手续费（用户 2026-11-23 定的规则）。
 * 用户用「自己的 Key」时：平台不收费，这里算出来的模型费只是记下来给用户对账用。
 *
 * 价格来自 DeepSeek 官方价格页（2026-11-23 核对）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 官方调价时改这里。单位「元 / 百万 token」，数值上正好等于「微元 / token」（1 元 = 1,000,000 微元）。
 */
export interface ModelPrice {
  /** 输入，缓存命中 */
  hit: number;
  /** 输入，缓存未命中 */
  miss: number;
  /** 输出 */
  out: number;
}

/** 高峰时段的价格；空闲时段是它的一半 */
export const PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': { hit: 0.04, miss: 2, out: 8 },
  'deepseek-v4-pro': { hit: 0.3, miss: 9, out: 27 },
};

/** 没在价格表里的模型按这个算（宁可按便宜的算，不多收用户的钱） */
const FALLBACK = 'deepseek-flash';

/** 平台手续费，万分比：1000 = 10% */
export const FEE_RATE_BP = 1000;

export const MICRO = 1_000_000;

/**
 * 是不是 DeepSeek 的空闲时段（半价）。
 * 官方规则：北京时间周一到周五 9:00–12:00、14:00–18:00 是高峰，其余（含周末、法定节假日）是空闲。
 * 这里没有法定节假日表：节假日落在工作日的那几天会按高峰价算，比 DeepSeek 实际收的多。要精确就得加节假日表。
 */
export function isOffpeak(now: Date = new Date()): boolean {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay();
  if (day === 0 || day === 6) return true;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
  return !peak;
}

export function priceOf(model: string): ModelPrice {
  return PRICES[model] ?? PRICES[FALLBACK];
}

/** 一次调用的模型费（微元，向上取整到 1 微元） */
export function costMicro(model: string, hit: number, miss: number, out: number, offpeak: boolean): number {
  const p = priceOf(model);
  const raw = (hit * p.hit + miss * p.miss + out * p.out) * (offpeak ? 0.5 : 1);
  // 先收掉浮点误差（0.04 × 52000 会算出 2080.0000000000002），再向上取整
  return Math.ceil(Number(raw.toFixed(6)));
}

/** 手续费（微元，向上取整） */
export function feeMicro(cost: number): number {
  return Math.ceil((cost * FEE_RATE_BP) / 10000);
}

/** 微元 → 「0.1101」这样的元（明细用，4 位小数） */
export function yuan4(micro: number | bigint): string {
  return (Number(micro) / MICRO).toFixed(4);
}

/**
 * 模型费、手续费、合计三个数一起转成 4 位小数的元。
 * 各自四舍五入的话会出现「0.0064 + 0.0006 = 0.0071」这种对不上的情况，所以手续费用「合计 − 模型费」倒推。
 */
export function split4(cost: number, fee: number) {
  const c = Math.round(cost / 100);
  const t = Math.round((cost + fee) / 100);
  const f = (n: number) => (n / 10000).toFixed(4);
  return { cost: f(c), fee: f(t - c), total: f(t) };
}

/** 微元 → 「4.88」这样的元（余额用，2 位小数，向下取，不让用户看到比实际多的钱） */
export function yuan2(micro: number | bigint): string {
  return (Math.floor(Number(micro) / 10_000) / 100).toFixed(2);
}
