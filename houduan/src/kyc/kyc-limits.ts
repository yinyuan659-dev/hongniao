import { HttpException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/**
 * 刷脸找回 / 并号的每日次数上限（防乱试、防刷钱）。数字是 2026-11-24 出样稿时先定的，用户过关时没改：
 *   - 同一台设备一天最多查 5 次「这张身份证有没有账号」；同一个网络地址一天 20 次。
 *   - 同一张身份证一天最多发起 3 次刷脸找回 / 并号（阿里云每刷完一次收 1 元，通过不通过都收）。
 * 「一天」按北京时间算。
 */
export const RECOVER_PER_DEVICE = 5;
export const RECOVER_PER_IP = 20;
export const FACE_PER_ID = 3;

/** 北京时间的今天，yyyymmdd */
function today(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 今天第几次了；超过上限抛 429（reason: too_many） */
export async function dayLimit(redis: RedisService, key: string, limit: number, message: string) {
  const k = `${key}:${today()}`;
  const n = await redis.client.incr(k);
  if (n === 1) await redis.client.expire(k, 86400 + 600);
  if (n > limit) throw new HttpException({ message, reason: 'too_many' }, 429);
}

/** 同一张身份证一天刷脸找回 / 并号的次数上限 */
export function faceCap(redis: RedisService, idHash: string) {
  return dayLimit(redis, `kyc:face:${idHash}`, FACE_PER_ID, '这张身份证今天刷脸的次数太多了，明天再试');
}
