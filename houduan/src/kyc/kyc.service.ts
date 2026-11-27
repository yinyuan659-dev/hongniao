import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AiWalletService } from '../ai/ai-wallet.service';
import { getKycRequired, KYC_FEE_MICRO } from '../common/kyc-gate';
import { yuan2 } from '../ai/ai-price';
import { validIdCard } from '../user/user.service';
import { createKycProvider, KycProvider, newBizId } from './kyc-provider';
import { RedisService } from '../redis/redis.service';
import { faceCap } from './kyc-limits';

/**
 * 实人认证（身份证 + 刷脸，一次完成）。并进基础画像的最后一步。
 * 只存结果（是否通过）和身份证哈希（一证一号），不存证号明文、不存姓名、不存人脸照片。
 * 通过才扣 ¥1（成本价，不加手续费，从 AI 余额扣）；不通过不扣。
 */
@Injectable()
export class KycService {
  private readonly provider: KycProvider = createKycProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly wallet: AiWalletService,
    private readonly redis: RedisService,
  ) {}

  /** 当前状态：有没有认证过、后台要不要求、费用、余额 */
  async status(userId: bigint) {
    const [user, required, w] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { realStatus: true } }),
      getKycRequired(this.prisma),
      this.wallet.get(userId),
    ]);
    if (!user) throw new NotFoundException('用户不存在');
    return {
      realname: user.realStatus === 1,
      /** 后台开关：聊天 / 发动态 / 评论要不要先实人认证 */
      required,
      feeMicro: KYC_FEE_MICRO,
      feeYuan: (KYC_FEE_MICRO / 1_000_000).toFixed(2),
      balanceMicro: Number(w.balance),
      balanceYuan: yuan2(w.balance),
      provider: this.provider.name,
    };
  }

  /**
   * 发起认证：校验姓名 / 身份证 / 年龄 / 一证一号 / 余额，建一条 pending 记录，返回刷脸页地址。
   * metaInfo、mobile 只有阿里云用得上（浏览器环境参数、是不是手机浏览器），mock 不看。
   */
  async start(userId: bigint, name: string, idNo: string, metaInfo = '', mobile = false) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, realStatus: true } });
    if (!user) throw new NotFoundException('用户不存在');
    if (user.realStatus === 1) throw new BadRequestException('你已完成实人认证');

    const realName = (name ?? '').trim();
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(realName)) throw new BadRequestException('请输入正确的真实姓名');
    const card = (idNo ?? '').trim().toUpperCase();
    if (!validIdCard(card)) throw new BadRequestException('身份证号不正确');
    if (ageFromId(card) < 18) throw new BadRequestException('未满 18 周岁，不能使用本平台');

    const idHash = this.crypto.idHash(card);
    // 一证一号。这张身份证已经有一个认证过的账号（换了手机又注册了新号）：
    // 不直接拦，照样让他刷脸证明是本人，通过后让他确认回到原来的账号（并号，见 RecoverService.mergeConfirm）。
    // 发起时不透露「有老账号」，刷脸通过才显示。
    const other = await this.prisma.user.findUnique({ where: { idHash }, select: { id: true, realStatus: true, mergedInto: true } });
    let mergeInto: bigint | null = null;
    if (other && other.id !== userId) {
      if (other.realStatus !== 1 || other.mergedInto) {
        throw new BadRequestException({ message: '该身份证已被其他账号实名认证', reason: 'id_used_other' });
      }
      mergeInto = other.id;
    }

    if (mergeInto) {
      // 并号的 1 元从老账号扣（不够平台出），不看新号的余额；同一张身份证一天刷脸的次数有上限
      await faceCap(this.redis, idHash);
    } else {
      const w = await this.wallet.get(userId);
      if (w.balance < BigInt(KYC_FEE_MICRO)) {
        throw new BadRequestException({ message: '牵豆不足，无法完成实人认证', reason: 'no_balance' });
      }
    }

    const bizId = newBizId();
    const started = await this.provider.start({ name: realName, idNo: card, bizId, metaInfo, mobile });
    await this.prisma.kycRecord.create({
      data: {
        userId, certifyId: started.certifyId, provider: this.provider.name, status: 'pending', idHash,
        purpose: mergeInto ? 'merge' : 'kyc', targetUserId: mergeInto,
      },
    });
    return { certifyId: started.certifyId, url: started.url, provider: this.provider.name };
  }

  /** 并号确认框里显示的内容：老账号是谁、新号里有多少余额会转过去 */
  private async mergeInfo(userId: bigint, targetUserId: bigint) {
    const [old, me, w] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: targetUserId }, select: { nickname: true, avatar: true, shortId: true, createdAt: true } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { nickname: true } }),
      this.wallet.get(userId),
    ]);
    if (!old) throw new BadRequestException('原来的账号已经不存在了');
    return {
      nickname: old.nickname, avatar: old.avatar, shortId: old.shortId, createdAt: old.createdAt,
      myNickname: me?.nickname ?? '', myBalanceYuan: yuan2(w.balance),
    };
  }

  /** 刷脸结束后查结果：通过就扣费、写实名状态；不通过不扣 */
  async finish(userId: bigint, certifyId: string) {
    const record = await this.prisma.kycRecord.findUnique({ where: { certifyId } });
    // 找回用的刷脸记录不走这里（那是没登录的设备发起的，查结果在 /recover/finish）
    if (!record || record.userId !== userId || record.purpose === 'recover') throw new NotFoundException('认证记录不存在');
    if (record.status === 'passed') return { passed: true, ...(await this.status(userId)) };
    // 并号：刷脸已经通过，等用户在确认框里点「进入原来的账号」
    if (record.status === 'merge_ready' && record.targetUserId) {
      return { passed: true, merge: await this.mergeInfo(userId, record.targetUserId) };
    }
    if (record.status !== 'pending') throw new BadRequestException('这次认证已结束，请重新发起');

    const res = await this.provider.result(certifyId);
    if (!res.passed) {
      // 没刷完就回来了（中途退出、还在处理）：不算失败，记录保持 pending，可以再查一次或者重新发起
      if (res.unfinished) return { passed: false, unfinished: true, reason: res.reason || '刷脸还没有完成' };
      const reason = res.reason || '认证未通过';
      await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'failed', reason } });
      return { passed: false, reason };
    }

    // 并号：这张身份证已经有一个认证过的账号。刷脸通过只说明是本人，这个新号不改，等用户确认要不要回到原来的账号
    if (record.purpose === 'merge' && record.targetUserId) {
      await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'merge_ready' } });
      return { passed: true, merge: await this.mergeInfo(userId, record.targetUserId) };
    }

    // 通过：先占住证号（一证一号，原子），再扣费。余额不够先报错，充值后可重新 finish。
    const w = await this.wallet.get(userId);
    if (w.balance < BigInt(KYC_FEE_MICRO)) {
      throw new BadRequestException({ message: '牵豆不足，无法完成实人认证', reason: 'no_balance' });
    }
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { idHash: record.idHash, realStatus: 1, realAt: new Date() } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'failed', reason: '该身份证已被其他账号实名认证' } });
        throw new BadRequestException({ message: '该身份证已被其他账号实名认证', reason: 'id_used_other' });
      }
      throw e;
    }
    const charged = await this.wallet.charge(userId, KYC_FEE_MICRO, 'kyc', `kyc:${certifyId}`, '实人认证');
    await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'passed', costMicro: BigInt(KYC_FEE_MICRO) } });

    return { passed: true, realname: true, balanceMicro: charged.balanceMicro, balanceYuan: charged.balance };
  }
}

/** 从 18 位身份证号算周岁 */
export function ageFromId(idNo: string): number {
  const y = Number(idNo.slice(6, 10));
  const m = Number(idNo.slice(10, 12));
  const d = Number(idNo.slice(12, 14));
  if (!(y > 1900)) return 0;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
  return age;
}
