import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { FEE_RATE_BP, MICRO, PRICES, split4, yuan2, yuan4 } from './ai-price';

/** 明细里每个功能显示成什么名字 */
const FEATURE_TITLE: Record<string, string> = {
  deep: 'AI 深聊',
  portrait: '生成相亲画像',
  keytest: '测试 Key',
  reason: '推荐理由',
  ice: '开场白',
};

/** 固定扣费（AiLedger 里非充值的 type）在明细里显示成什么名字 */
const LEDGER_TITLE: Record<string, string> = {
  kyc: '实人认证',
  /** 新设备刷脸找回账号、并号时的那次刷脸 */
  recover: '刷脸找回',
  /** 并号：这个号作废，余额转到了原来的账号 */
  merge: '转到原来的账号',
};

/** 明细标题后面跟的数量：深聊是几轮，推荐理由是写了几位 */
function countSuffix(feature: string, count: number): string {
  return feature === 'deep' ? ` · ${count} 轮` : feature === 'reason' ? ` · ${count} 位` : '';
}

/**
 * AI 余额、付费方式、用户自己的 Key、费用明细。
 * 余额单位是微元（1 元 = 1,000,000），因为一次模型调用只有几厘钱。
 */
@Injectable()
export class AiWalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** 取钱包，没有就建一个空的 */
  async get(userId: bigint) {
    return this.prisma.aiWallet.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  /** 给客户端看的：余额、付费方式、Key 状态、收费规则 */
  async view(userId: bigint) {
    const w = await this.get(userId);
    return {
      /** 余额（元，2 位小数） */
      balance: yuan2(w.balance),
      balanceMicro: Number(w.balance),
      /** platform = 平台余额；own = 自己的 Key */
      payMode: w.payMode === 'own' && w.keyEnc ? 'own' : 'platform',
      key: w.keyEnc ? { tail: w.keyTail, checkedAt: w.keyCheckedAt } : null,
      autoFallback: w.autoFallback,
      /** 手续费百分比 */
      feePercent: FEE_RATE_BP / 100,
      /** 收款通道还没接：充值页只能看 */
      canTopup: false,
      model: process.env.AI_MODEL ?? 'deepseek-flash',
      prices: PRICES,
    };
  }

  async setMode(userId: bigint, payMode: string) {
    if (payMode !== 'platform' && payMode !== 'own') throw new BadRequestException('付费方式不对');
    const w = await this.get(userId);
    if (payMode === 'own' && !w.keyEnc) throw new BadRequestException('请先填写你自己的 Key');
    await this.prisma.aiWallet.update({ where: { userId }, data: { payMode } });
    return this.view(userId);
  }

  async setAutoFallback(userId: bigint, on: boolean) {
    await this.get(userId);
    await this.prisma.aiWallet.update({ where: { userId }, data: { autoFallback: on } });
    return this.view(userId);
  }

  /** 保存用户自己的 Key（调用方已经测试过能用）。保存后付费方式切到「自己的 Key」 */
  async saveKey(userId: bigint, key: string) {
    await this.get(userId);
    await this.prisma.aiWallet.update({
      where: { userId },
      data: { keyEnc: this.crypto.seal(key), keyTail: key.slice(-4), keyCheckedAt: new Date(), payMode: 'own' },
    });
    return this.view(userId);
  }

  async markKeyChecked(userId: bigint) {
    await this.prisma.aiWallet.update({ where: { userId }, data: { keyCheckedAt: new Date() } });
    return this.view(userId);
  }

  /** 删除 Key，付费方式回到平台余额 */
  async deleteKey(userId: bigint) {
    await this.get(userId);
    await this.prisma.aiWallet.update({ where: { userId }, data: { keyEnc: '', keyTail: '', keyCheckedAt: null, payMode: 'platform' } });
    return this.view(userId);
  }

  /** 解出用户自己的 Key（只在调用模型前用，不返回给客户端） */
  openKey(keyEnc: string): string {
    return this.crypto.open(keyEnc);
  }

  /**
   * 进账（充值到账 / 平台发放）。refKey 相同的只记一次，重复调用不会重复加钱。
   * 返回 { added: 这次有没有真的加上, balance }
   */
  async credit(userId: bigint, micro: number, refKey: string, note: string) {
    if (!Number.isInteger(micro) || micro <= 0) throw new BadRequestException('金额不对');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('用户不存在');
    await this.get(userId);
    const done = await this.prisma.aiLedger.findUnique({ where: { userId_type_refKey: { userId, type: 'topup', refKey } } });
    if (done) return { added: false, balance: yuan2((await this.get(userId)).balance) };
    const w = await this.prisma.$transaction(async (tx) => {
      const after = await tx.aiWallet.update({ where: { userId }, data: { balance: { increment: BigInt(micro) } } });
      await tx.aiLedger.create({ data: { userId, type: 'topup', amount: BigInt(micro), balanceAfter: after.balance, refKey, note: note.slice(0, 60) } });
      return after;
    });
    return { added: true, balance: yuan2(w.balance) };
  }

  /**
   * 固定金额扣费（不是模型调用，用于实人认证这类按次收费）。
   * type+refKey+userId 唯一，重复调用不会重复扣。余额不够抛 402（reason: no_balance）。
   * AiLedger.amount 记成负数，balanceAfter 记扣后余额；费用明细里按 type 显示成「实人认证」等。
   */
  async charge(userId: bigint, micro: number, type: string, refKey: string, note: string) {
    if (!Number.isInteger(micro) || micro <= 0) throw new BadRequestException('金额不对');
    const w = await this.get(userId);
    const done = await this.prisma.aiLedger.findUnique({ where: { userId_type_refKey: { userId, type, refKey } } });
    if (done) return { charged: false, balance: yuan2(w.balance), balanceMicro: Number(w.balance) };
    if (w.balance < BigInt(micro)) {
      throw new BadRequestException({ message: '余额不足', reason: 'no_balance' });
    }
    const after = await this.prisma.$transaction(async (tx) => {
      const u = await tx.aiWallet.update({ where: { userId }, data: { balance: { decrement: BigInt(micro) } } });
      await tx.aiLedger.create({ data: { userId, type, amount: BigInt(-micro), balanceAfter: u.balance, refKey, note: note.slice(0, 60) } });
      return u;
    });
    return { charged: true, balance: yuan2(after.balance), balanceMicro: Number(after.balance) };
  }

  /**
   * 后台给账号加余额（收款通道接好之前，测试期的余额靠这个进来）。
   * who：6 位短号或用户 id；yuan：加多少元；refKey：批次号，同一个批次号只加一次。
   */
  async adminCredit(who: string, yuan: number, refKey: string, note: string) {
    if (!(yuan > 0 && yuan <= 1000)) throw new BadRequestException('金额要在 0～1000 元之间');
    if (!/^[\w:-]{4,64}$/.test(refKey)) throw new BadRequestException('批次号不对');
    const user = /^\d{6}$/.test(who)
      ? await this.prisma.user.findUnique({ where: { shortId: who }, select: { id: true, shortId: true, nickname: true } })
      : /^\d{1,19}$/.test(who) ? await this.prisma.user.findUnique({ where: { id: BigInt(who) }, select: { id: true, shortId: true, nickname: true } }) : null;
    if (!user) throw new NotFoundException('用户不存在');
    const r = await this.credit(user.id, Math.round(yuan * MICRO), refKey, note || '平台发放');
    return { userId: user.id, shortId: user.shortId, nickname: user.nickname, ...r };
  }

  /**
   * 费用明细（按月）。一次深聊会调很多次模型，这里按 groupKey 合成一条。
   * kind：all 全部 | spend 花掉的 | topup 充值
   */
  async ledger(userId: bigint, month: string | undefined, kind: string | undefined) {
    const { from, to, label } = monthRange(month);
    const range = { gte: from, lt: to };
    const usages = kind === 'topup' ? [] : await this.prisma.aiUsage.findMany({ where: { userId, createdAt: range }, orderBy: { id: 'asc' } });
    const topups = kind === 'spend' ? [] : await this.prisma.aiLedger.findMany({ where: { userId, type: 'topup', createdAt: range }, orderBy: { id: 'asc' } });
    // 固定扣费（实人认证等，不是模型调用，记在 AiLedger 里，amount 为负）
    const charges = kind === 'topup' ? [] : await this.prisma.aiLedger.findMany({ where: { userId, type: { notIn: ['topup'] }, createdAt: range }, orderBy: { id: 'asc' } });

    const groups = new Map<string, { feature: string; count: number; cost: number; fee: number; own: number; first: Date; last: Date }>();
    for (const u of usages) {
      const g = groups.get(u.groupKey) ?? { feature: u.feature, count: 0, cost: 0, fee: 0, own: 0, first: u.createdAt, last: u.createdAt };
      g.count += 1;
      g.last = u.createdAt;
      if (u.payMode === 'own') g.own += 1;
      else {
        g.cost += Number(u.costMicro);
        g.fee += Number(u.feeMicro);
      }
      groups.set(u.groupKey, g);
    }

    const items = [
      ...[...groups.entries()].map(([groupKey, g]) => ({
        kind: 'usage' as const,
        groupKey,
        title: (FEATURE_TITLE[g.feature] ?? 'AI 功能') + countSuffix(g.feature, g.count),
        time: g.last,
        /** 全部是用自己的 Key 调的：平台没扣费 */
        ownKey: g.own === g.count,
        cost: split4(g.cost, g.fee).cost,
        fee: split4(g.cost, g.fee).fee,
        amount: split4(g.cost, g.fee).total,
        note: '',
      })),
      ...charges.map((c) => ({
        kind: 'usage' as const,
        groupKey: '',
        title: LEDGER_TITLE[c.type] ?? 'AI 功能',
        time: c.createdAt,
        ownKey: false,
        cost: '',
        fee: '',
        amount: (-Number(c.amount) / MICRO).toFixed(4),
        note: c.note,
      })),
      ...topups.map((t) => ({
        kind: 'topup' as const,
        groupKey: '',
        title: '充值',
        time: t.createdAt,
        ownKey: false,
        cost: '',
        fee: '',
        amount: (Number(t.amount) / MICRO).toFixed(2),
        note: t.note,
      })),
    ].sort((a, b) => b.time.getTime() - a.time.getTime());

    const spend = [...groups.values()].reduce((s, g) => s + g.cost + g.fee, 0) + charges.reduce((s, c) => s - Number(c.amount), 0);
    const topup = topups.reduce((s, t) => s + Number(t.amount), 0);
    return { month: label, spend: yuan4(spend), topup: (topup / MICRO).toFixed(2), items };
  }

  /** 一条明细的用量详情：用了哪个模型、读了多少写了多少、模型费和手续费各多少 */
  async usageDetail(userId: bigint, groupKey: string) {
    const rows = await this.prisma.aiUsage.findMany({ where: { userId, groupKey }, orderBy: { id: 'asc' } });
    if (rows.length === 0) throw new NotFoundException('没有这条明细');
    const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
    const paid = rows.filter((r) => r.payMode !== 'own');
    const cost = paid.reduce((s, r) => s + Number(r.costMicro), 0);
    const fee = paid.reduce((s, r) => s + Number(r.feeMicro), 0);
    return {
      title: (FEATURE_TITLE[rows[0].feature] ?? 'AI 功能') + countSuffix(rows[0].feature, rows.length),
      from: rows[0].createdAt,
      to: rows[rows.length - 1].createdAt,
      model: [...new Set(rows.map((r) => r.model))].join('、'),
      /** AI 读的内容（输入）= 命中缓存 + 没命中 */
      inTokens: sum((r) => r.hitTokens + r.missTokens),
      hitTokens: sum((r) => r.hitTokens),
      outTokens: sum((r) => r.outTokens),
      ownKey: paid.length === 0,
      // 用自己的 Key 时没扣费，这里的 cost 是按官方价估出来给用户参考的
      ...(paid.length === 0 ? { cost: yuan4(sum((r) => Number(r.costMicro))), fee: yuan4(0), total: yuan4(0) } : split4(cost, fee)),
      feePercent: FEE_RATE_BP / 100,
    };
  }

  /** 某一组调用一共扣了多少（深聊页底部「本次已花」用） */
  async groupSpent(userId: bigint, groupKeys: string[]) {
    const rows = await this.prisma.aiUsage.findMany({
      where: { userId, groupKey: { in: groupKeys } },
      select: { costMicro: true, feeMicro: true, payMode: true },
    });
    const paid = rows.filter((r) => r.payMode !== 'own');
    const cost = paid.reduce((s, r) => s + Number(r.costMicro), 0);
    const fee = paid.reduce((s, r) => s + Number(r.feeMicro), 0);
    return { ...split4(cost, fee), ownKey: rows.length > 0 && paid.length === 0, calls: rows.length };
  }
}

/** 'YYYY-MM' → 那个月的起止时间（按北京时间算）；不传或格式不对用当月 */
function monthRange(month?: string) {
  const bjNow = new Date(Date.now() + 8 * 3600_000);
  let y = bjNow.getUTCFullYear();
  let m = bjNow.getUTCMonth() + 1;
  const hit = /^(\d{4})-(\d{2})$/.exec(month ?? '');
  if (hit && Number(hit[2]) >= 1 && Number(hit[2]) <= 12) {
    y = Number(hit[1]);
    m = Number(hit[2]);
  }
  const from = new Date(Date.UTC(y, m - 1, 1) - 8 * 3600_000);
  const to = new Date(Date.UTC(y, m, 1) - 8 * 3600_000);
  return { from, to, label: `${y}-${String(m).padStart(2, '0')}` };
}
