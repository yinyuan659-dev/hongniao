import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './auth.dto';
import { browserLabel, DeviceService } from './device.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly devices: DeviceService,
  ) {}

  /**
   * 启动进入：这台设备挂在哪个账号下就登录哪个（设备表为准，见 DeviceService）。
   * 不认识、或者已被移除 → registered=false，客户端去注册页（那里有「刷脸找回」）。
   * did：这台设备在设备表里的行 id，写进登录令牌（移除设备时靠它让令牌失效）。
   * newDevices：上次用这台设备之后，通过刷脸新挂到这个账号上的其它设备，客户端提醒一次。
   */
  async enter(deviceId: string, ua = '') {
    const dev = await this.devices.resolve(deviceId, true, browserLabel(ua));
    const user = dev ? await this.prisma.user.findUnique({ where: { id: dev.userId } }) : null;
    if (!dev || !user) {
      return { registered: false, token: null, user: null };
    }
    if (user.status !== 0) {
      throw new BadRequestException('账号已被封禁');
    }
    const newDevices = await this.devices.newSince(user.id, dev.did, dev.prevSeen);
    return { registered: true, token: this.sign(user.id, dev.did), did: dev.did.toString(), user: this.toProfile(user), newDevices };
  }

  async register(dto: RegisterDto, ip = '') {
    const dev = await this.devices.resolve(dto.deviceId, true);
    const exists = dev ? await this.prisma.user.findUnique({ where: { id: dev.userId } }) : null;
    if (dev && exists) {
      // 一机一号：已注册直接恢复，不允许二次注册
      if (exists.status !== 0) throw new BadRequestException('账号已被封禁');
      return { registered: true, token: this.sign(exists.id, dev.did), did: dev.did.toString(), user: this.toProfile(exists), inviter: null };
    }
    // 这台设备以前注册过的号已经不归它了（被移除、或并号后作废）：把旧号上的设备号让出来，才能建新号
    await this.devices.release(dto.deviceId);

    const user = await this.prisma.user.create({
      data: {
        deviceId: dto.deviceId,
        shortId: await this.genShortId(),
        nickname: dto.nickname,
        age: dto.age,
        gender: dto.gender,
        avatar: dto.avatar ?? '',
      },
    });
    const { did } = await this.devices.attach(user.id, dto.deviceId, 'register');
    const inviter = await this.attributeInvite(user, dto.inviteCode, ip).catch(() => null);
    return { registered: true, token: this.sign(user.id, did), did: did.toString(), user: this.toProfile(user), inviter };
  }

  /**
   * 邀请归因（注册时执行一次）：
   * 1. 带了邀请码 → 按短号/ID 找邀请人；
   * 2. 否则找 48h 内「同 IP + 同平台（按 deviceId 前缀 and_/ios_）」最近一条未消费的邀请页访问记录。
   * 命中后写 user.inviterId、消费该记录；若邀请人是异性则新用户自动关注 TA，
   * 并把邀请人简况返回给客户端（客户端据此直接打开 TA 主页）。
   */
  private async attributeInvite(user: { id: bigint; gender: number; deviceId: string }, inviteCode: string | undefined, ip: string) {
    let inviterId: bigint | null = null;
    let clickId: bigint | null = null;

    const code = (inviteCode ?? '').trim();
    if (code) {
      const byCode = /^\d{6}$/.test(code)
        ? await this.prisma.user.findUnique({ where: { shortId: code } })
        : /^\d{1,19}$/.test(code) ? await this.prisma.user.findUnique({ where: { id: BigInt(code) } }) : null;
      if (byCode) inviterId = byCode.id;
    }
    if (!inviterId && ip) {
      const platform = user.deviceId.startsWith('ios_') ? 'ios' : user.deviceId.startsWith('and_') ? 'android' : 'other';
      const click = await this.prisma.inviteClick.findFirst({
        where: { ip, platform, claimedBy: null, createdAt: { gt: new Date(Date.now() - 48 * 3600_000) } },
        orderBy: { id: 'desc' },
      });
      if (click) {
        inviterId = click.inviterId;
        clickId = click.id;
      }
    }
    if (!inviterId || inviterId === user.id) return null;

    const inviter = await this.prisma.user.findUnique({ where: { id: inviterId } });
    if (!inviter || inviter.status !== 0) return null;

    await this.prisma.user.update({ where: { id: user.id }, data: { inviterId } });
    if (clickId) await this.prisma.inviteClick.update({ where: { id: clickId }, data: { claimedBy: user.id } });

    // 性别隔离：同性不可见，只记录归因不建立关系
    const visible = inviter.gender !== user.gender;
    if (visible) {
      await this.prisma.follow.upsert({
        where: { followerId_targetId: { followerId: user.id, targetId: inviterId } },
        update: {},
        create: { followerId: user.id, targetId: inviterId },
      });
    }
    return visible
      ? { id: inviter.id, nickname: inviter.nickname, avatar: inviter.avatar, gender: inviter.gender }
      : null;
  }

  /** did：设备表的行 id。带上它，这台设备被移除后令牌就不认了（JwtAuthGuard 里查） */
  private sign(userId: bigint, did?: bigint): string {
    return this.jwt.sign(did === undefined ? { sub: userId.toString() } : { sub: userId.toString(), did: did.toString() });
  }

  /** 给其它登录方式（审核演示账号、刷脸找回、并号）签发同款 token */
  signFor(userId: bigint, did?: bigint): string {
    return this.sign(userId, did);
  }

  /** 生成唯一 6 位数字短号（100000-999999） */
  private async genShortId(): Promise<string> {
    for (let i = 0; i < 20; i++) {
      const id = String(Math.floor(100000 + Math.random() * 900000));
      const exists = await this.prisma.user.findUnique({ where: { shortId: id } });
      if (!exists) return id;
    }
    throw new Error('短号生成失败，请重试');
  }

  toProfile(u: any) {
    return {
      id: u.id,
      shortId: u.shortId,
      nickname: u.nickname,
      avatar: u.avatar,
      gender: u.gender,
      age: u.age,
      cityCode: u.cityCode,
      cityName: u.cityName,
      signature: u.signature,
      isGuide: u.isGuide,
      /** 是不是领队（平台在后台设的）：是的话「我的」页多出「领队后台」 */
      isLeader: !!u.isLeader,
      /** 视频见面开关（默认关） */
      allowVideo: !!u.allowVideo,
      // 实人认证状态（只返回是否通过，不返回姓名和证号）
      realname: u.realStatus === 1,
      realNameMasked: '',
      createdAt: u.createdAt,
    };
  }
}
