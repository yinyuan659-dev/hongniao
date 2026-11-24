import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../common/crypto.service';
import { AiWalletService } from '../ai/ai-wallet.service';
import { AuthService } from '../auth/auth.service';
import { browserLabel, DeviceService, deviceKind, MAX_DEVICES } from '../auth/device.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { KYC_FEE_MICRO } from '../common/kyc-gate';
import { yuan2 } from '../ai/ai-price';
import { validIdCard } from '../user/user.service';
import { createKycProvider, KycProvider, newBizId } from './kyc-provider';
import { ageFromId } from './kyc.service';
import { dayLimit, faceCap, RECOVER_PER_DEVICE, RECOVER_PER_IP } from './kyc-limits';

/** 并号确认框：刷脸通过后多久之内要点确认 */
const MERGE_CONFIRM_MS = 30 * 60_000;

/**
 * 换手机找回 / 并号 / 登录设备（样稿 design/05-recover.html，用户 2026-11-24 过关）。
 * 不绑手机号：做过真人认证的人，在新设备上用「身份证 + 刷脸」回到原来的账号，一个账号可以挂多台设备。
 *
 *   找回（新设备上还没注册）：/recover/start 先查这张身份证有没有认证过的账号（用户定的「先查再刷」，
 *     没有就不刷脸、不花钱）→ 有就刷脸 → /recover/finish 通过后把这台设备挂到那个账号下并登录。
 *   并号（新设备上已经注册了新号，在新号里做真人认证，刷的是老账号那张身份证）：KycService 里照样刷脸，
 *     通过后记成 merge_ready；用户在确认框里点「进入原来的账号」→ mergeConfirm：新号作废、
 *     只把 AI 余额转到老账号、设备改挂到老账号下。
 *   刷脸通过之前，不返回老账号的任何信息。
 *   这 1 元：通过后从老账号的 AI 余额扣，余额不够就不扣（平台出）；没通过的也是平台出。
 */
@Injectable()
export class RecoverService {
  private readonly provider: KycProvider = createKycProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly wallet: AiWalletService,
    private readonly auth: AuthService,
    private readonly devices: DeviceService,
    private readonly registry: ConnectionRegistry,
  ) {}

  /** 找回第一步：先查有没有账号；有就发起刷脸，返回刷脸页地址 */
  async start(deviceId: string, name: string, idNo: string, metaInfo: string, mobile: boolean, ip: string) {
    const realName = (name ?? '').trim();
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(realName)) throw new BadRequestException('请输入正确的真实姓名');
    const card = (idNo ?? '').trim().toUpperCase();
    if (!validIdCard(card)) throw new BadRequestException('身份证号不正确');
    if (ageFromId(card) < 18) throw new BadRequestException('未满 18 周岁，不能使用本平台');

    // 这台设备上已经登录着一个号：不走找回（不然那个号就被悄悄丢掉了），在那个号里做真人认证会走并号
    if (await this.devices.resolve(deviceId)) {
      throw new BadRequestException({ message: '这台设备已经登录了一个账号，请在「我的」里完成真人认证', reason: 'device_in_use' });
    }

    await dayLimit(this.redis, `kyc:rc:dev:${deviceId}`, RECOVER_PER_DEVICE, '今天找回的次数太多了，明天再试');
    if (ip) await dayLimit(this.redis, `kyc:rc:ip:${ip}`, RECOVER_PER_IP, '今天找回的次数太多了，明天再试');

    const idHash = this.crypto.idHash(card);
    const owner = await this.prisma.user.findUnique({ where: { idHash }, select: { id: true, realStatus: true, mergedInto: true } });
    // 没有认证过的账号：不刷脸、不花钱
    if (!owner || owner.realStatus !== 1 || owner.mergedInto) return { found: false };

    await faceCap(this.redis, idHash);
    const started = await this.provider.start({ name: realName, idNo: card, bizId: newBizId(), metaInfo, mobile });
    await this.prisma.kycRecord.create({
      data: { userId: owner.id, certifyId: started.certifyId, provider: this.provider.name, status: 'pending', idHash, purpose: 'recover', deviceId },
    });
    return { found: true, certifyId: started.certifyId, url: started.url, provider: this.provider.name };
  }

  /** 找回第二步：刷完脸查结果。通过 → 这台设备挂到账号下，返回登录令牌 */
  async finish(deviceId: string, certifyId: string, ua: string) {
    const record = await this.prisma.kycRecord.findUnique({ where: { certifyId } });
    // 只有发起的那台设备能来查
    if (!record || record.purpose !== 'recover' || record.deviceId !== deviceId) throw new NotFoundException('认证记录不存在');

    if (record.status === 'passed') {
      // 已经找回成功过（比如结果页刷新了一下）：设备还挂在那个账号下就再给一次登录
      const dev = await this.devices.resolve(deviceId);
      if (!dev || dev.userId !== record.userId) throw new BadRequestException('这次找回已结束，请重新发起');
      return this.session(record.userId, dev.did, record.costMicro > 0n);
    }
    if (record.status !== 'pending') throw new BadRequestException('这次找回已结束，请重新发起');

    const res = await this.provider.result(certifyId);
    if (!res.passed) {
      if (res.unfinished) return { passed: false, unfinished: true, reason: res.reason || '刷脸还没有完成' };
      const reason = res.reason || '刷脸没通过';
      await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'failed', reason } });
      return { passed: false, reason };
    }

    const user = await this.prisma.user.findUnique({ where: { id: record.userId }, select: { id: true, idHash: true, mergedInto: true } });
    if (!user || user.idHash !== record.idHash || user.mergedInto) {
      await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'failed', reason: '账号已经不存在' } });
      throw new BadRequestException('这个账号已经不存在了');
    }

    const { did, kicked } = await this.devices.attach(user.id, deviceId, 'recover', deviceKind(deviceId) === 'web' ? browserLabel(ua) : '');
    const cost = await this.tryCharge(user.id, certifyId, '刷脸找回账号');
    await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'passed', costMicro: BigInt(cost) } });
    await this.announce(user.id, did, kicked);
    return this.session(user.id, did, cost > 0);
  }

  /**
   * 并号确认：在新号里刷脸通过（KycService 记成了 merge_ready），用户点了「进入原来的账号」。
   * 新号作废（不能再登录、不再出现在任何列表里），只把 AI 余额转到老账号，设备改挂到老账号下。
   * 资料、照片、喜欢、聊天都不合并（样稿里定的）。每一步都可以重来，中途失败再点一次确认就行。
   */
  async mergeConfirm(userId: bigint, currentDid: bigint | undefined, certifyId: string) {
    const record = await this.prisma.kycRecord.findUnique({ where: { certifyId } });
    if (!record || record.userId !== userId || record.purpose !== 'merge' || !record.targetUserId) throw new NotFoundException('认证记录不存在');
    if (record.status !== 'merge_ready') throw new BadRequestException('这次认证已结束，请重新发起');
    if (Date.now() - record.updatedAt.getTime() > MERGE_CONFIRM_MS) {
      await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'failed', reason: '确认超时' } });
      throw new BadRequestException('等太久了，请重新认证');
    }
    // 老的登录令牌里没有设备信息，不知道该把哪台设备挂过去
    if (currentDid === undefined) throw new BadRequestException({ message: '请重新打开 App 后再试', reason: 'need_relogin' });

    const oldId = record.targetUserId;
    const old = await this.prisma.user.findUnique({ where: { id: oldId }, select: { id: true, idHash: true, realStatus: true, mergedInto: true } });
    if (!old || old.idHash !== record.idHash || old.realStatus !== 1 || old.mergedInto) throw new BadRequestException('原来的账号已经不存在了');

    // 正在用的这台设备必须是这个新号的（上一次确认做到一半的话，它可能已经挂到老账号下了）
    const cur = await this.prisma.userDevice.findUnique({ where: { id: currentDid } });
    if (!cur || cur.revokedAt || (cur.userId !== userId && cur.userId !== old.id)) {
      throw new BadRequestException({ message: '请重新打开 App 后再试', reason: 'need_relogin' });
    }

    // 1. 新号里的 AI 余额转到老账号（两边各记一条明细）
    const balance = Number((await this.wallet.get(userId)).balance);
    if (balance > 0) {
      await this.wallet.charge(userId, balance, 'merge', `merge:${old.id}`, '转到原来的账号');
      await this.wallet.credit(old.id, balance, `merge:${userId}`, '另一个账号并入');
    }

    // 2. 新号上的设备改挂到老账号下（同一台设备在设备表里还是同一行，did 不变）
    const kicked: bigint[] = [];
    for (const d of await this.devices.activeOf(userId)) {
      const r = await this.devices.attach(old.id, d.deviceId, 'merge', d.label);
      kicked.push(...r.kicked);
    }

    // 3. 新号作废：已经发出去的登录令牌全部失效（放在设备搬完之后，免得中途失败把人卡在一个废号里）
    await this.prisma.user.update({ where: { id: userId }, data: { status: 1, mergedInto: old.id } });
    await this.devices.killUser(userId);

    // 4. 刷脸的 1 元从老账号扣（余额转过去以后再扣），不够就不扣
    const cost = await this.tryCharge(old.id, certifyId, '并号刷脸');
    await this.prisma.kycRecord.update({ where: { certifyId }, data: { status: 'merged', costMicro: BigInt(cost) } });

    this.registry.kickLocal(userId);
    await this.announce(old.id, currentDid, kicked);
    return { ...(await this.session(old.id, currentDid, cost > 0)), movedYuan: (balance / 1_000_000).toFixed(2) };
  }

  /** 登录设备列表 */
  async deviceList(userId: bigint, currentDid?: bigint) {
    const [list, user] = await Promise.all([
      this.devices.list(userId, currentDid),
      this.prisma.user.findUnique({ where: { id: userId }, select: { realStatus: true } }),
    ]);
    return { devices: list, max: MAX_DEVICES, realname: user?.realStatus === 1 };
  }

  /** 移除一台设备：它马上退出 */
  async removeDevice(userId: bigint, id: bigint, currentDid?: bigint) {
    const removed = await this.devices.remove(userId, id, currentDid);
    await this.kick(userId, removed);
    return { ok: true };
  }

  /** 登录成功后给客户端的东西：令牌、设备行 id、用户资料 */
  private async session(userId: bigint, did: bigint, charged: boolean) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('这个账号已经不存在了');
    // 被封的号也能找回进去，但看到的是封禁提示（不让人另开一个新号绕过去）
    if (user.status !== 0) throw new BadRequestException('账号已被封禁');
    const w = await this.wallet.get(userId);
    return {
      passed: true, token: this.auth.signFor(userId, did), did: did.toString(), user: this.auth.toProfile(user),
      charged, feeYuan: (KYC_FEE_MICRO / 1_000_000).toFixed(2), balanceYuan: yuan2(w.balance),
    };
  }

  /** 刷脸的 1 元：余额够就扣，不够就不扣（平台出）。返回实际扣了多少微元 */
  private async tryCharge(userId: bigint, certifyId: string, note: string): Promise<number> {
    try {
      await this.wallet.charge(userId, KYC_FEE_MICRO, 'recover', `recover:${certifyId}`, note);
      return KYC_FEE_MICRO;
    } catch (e) {
      const reason = (e as { getResponse?: () => unknown })?.getResponse?.() as { reason?: string } | undefined;
      if (reason?.reason === 'no_balance') return 0;
      throw e;
    }
  }

  /** 告诉这个账号的其它设备：有新设备登录了；被顶掉的设备让它退出 */
  private async announce(userId: bigint, did: bigint, kicked: bigint[]) {
    const brief = await this.devices.brief(did);
    if (brief) await this.registry.deliver([userId], { op: 'device', event: 'added', data: brief });
    for (const k of kicked) await this.kick(userId, k);
  }

  private async kick(userId: bigint, did: bigint) {
    await this.registry.deliver([userId], { op: 'device', event: 'removed', data: { id: did.toString() } });
    this.registry.kickLocal(userId, did.toString());
  }
}
