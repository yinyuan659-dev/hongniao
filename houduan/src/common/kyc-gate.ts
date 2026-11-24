import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 「做过实人认证才能聊天 / 发动态 / 评论」的判断（服务端强制，客户端绕不过去）。
 *
 * 用户 2026-11-23 定：实名并进基础画像，受一个后台开关控制，默认关。
 *   - 开关关着时：不拦，答完资料就能用（支付上线前用测试号走流程）。
 *   - 开关打开后：没做过实人认证（realStatus≠1）的人，发消息、打电话、发动态、评论都被拦。
 * 浏览、填资料、点喜欢不受这个门槛影响（点喜欢 / 被推荐只看 profileReady，见 chat-gate.ts）。
 */

/** 客户端按这个 code 弹「去完成实人认证」（HTTP 的 reason、WebSocket 的 error 帧都带） */
export const NEED_KYC_CODE = 'need_kyc';

/** 没做实人认证就想聊天 / 发动态 / 评论 */
export class NeedKycException extends ForbiddenException {
  readonly code = NEED_KYC_CODE;
  constructor(message = '请先完成实人认证') {
    super({ message, reason: NEED_KYC_CODE });
  }
}

const KEY_REQUIRED = 'kyc_required';
/** 实人认证费用（微元）：¥1，成本价，不加手续费 */
export const KYC_FEE_MICRO = 1_000_000;

let cache: { at: number; on: boolean } | null = null;
const CACHE_MS = 30_000;

/** 后台开关：是否要求实人认证才能聊天 / 发动态 / 评论（默认关） */
export async function getKycRequired(prisma: PrismaService, fresh = false): Promise<boolean> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.on;
  const row = await prisma.sysSetting.findUnique({ where: { key: KEY_REQUIRED } });
  const on = row?.value === '1';
  cache = { at: Date.now(), on };
  return on;
}

export async function setKycRequired(prisma: PrismaService, on: boolean): Promise<boolean> {
  await prisma.sysSetting.upsert({
    where: { key: KEY_REQUIRED },
    create: { key: KEY_REQUIRED, value: on ? '1' : '0' },
    update: { value: on ? '1' : '0' },
  });
  cache = { at: Date.now(), on };
  return on;
}

/** 已通过实人认证？ */
export async function isKyced(prisma: PrismaService, userId: bigint): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { realStatus: true } });
  return u?.realStatus === 1;
}

/** 发消息 / 打电话 / 发动态 / 评论前调用：开关开着且没认证就抛 NeedKycException */
export async function assertKyc(prisma: PrismaService, userId: bigint): Promise<void> {
  if (!(await getKycRequired(prisma))) return;
  if (await isKyced(prisma, userId)) return;
  throw new NeedKycException();
}
