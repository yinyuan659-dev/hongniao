import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserDevice } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** 一个账号最多挂几台设备；满了再加，顶掉最久没用的那台 */
export const MAX_DEVICES = 5;

/** 登录令牌有效期 30 天；「这台设备 / 这个号已经不能用了」的标记比它多留一天就够 */
const DEAD_TTL_SEC = 31 * 86400;

/** 被移除的设备（设备表的行 id）：带着它的登录令牌一律拒绝 */
export const deviceDeadKey = (did: bigint | string) => `auth:did:x:${did}`;
/** 并号后作废的账号：它的登录令牌一律拒绝 */
export const userDeadKey = (userId: bigint | string) => `auth:uid:x:${userId}`;

/** 设备号前缀 → 设备类型 */
export function deviceKind(deviceId: string): 'android' | 'ios' | 'web' {
  return deviceId.startsWith('and_') ? 'android' : deviceId.startsWith('ios_') ? 'ios' : 'web';
}

/** 网页端：从 User-Agent 看是哪个浏览器（只用来在设备列表里显示，认不出来就是空） */
export function browserLabel(ua: string | undefined): string {
  const s = ua ?? '';
  if (/MicroMessenger/i.test(s)) return '微信';
  if (/Edg(e|A|iOS)?\//.test(s)) return 'Edge';
  if (/HuaweiBrowser/i.test(s)) return '华为浏览器';
  if (/MiuiBrowser/i.test(s)) return '小米浏览器';
  if (/Firefox|FxiOS/.test(s)) return 'Firefox';
  if (/Chrome|CriOS/.test(s)) return 'Chrome';
  if (/Safari/.test(s)) return 'Safari';
  return '';
}

export interface DeviceView {
  id: string;
  kind: string;
  label: string;
  via: string;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

/**
 * 登录设备：账号认人，设备只是登录这个账号的钥匙，一个账号可以挂多台。
 * 这里只管「哪台设备属于哪个账号」；新设备怎么证明是本人（刷脸找回 / 并号）在 kyc/recover.service.ts。
 */
@Injectable()
export class DeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * 这台设备现在登录的是哪个账号。不认识、或者已经被移除，返回 null。
   * touch：顺便记一次「刚用过」。prevSeen 是这次之前最后用的时间（用来找「我不在的时候新加进来的设备」）。
   */
  async resolve(deviceId: string, touch = false, label = ''): Promise<{ userId: bigint; did: bigint; prevSeen: Date } | null> {
    let row = await this.prisma.userDevice.findUnique({ where: { deviceId } });
    if (!row) {
      // 设备表上线前注册的老账号：按 user.device_id 认，第一次见到时补一行
      const u = await this.prisma.user.findUnique({ where: { deviceId }, select: { id: true, mergedInto: true } });
      if (!u || u.mergedInto) return null;
      await this.ensureOriginal(u.id);
      row = await this.prisma.userDevice.findUnique({ where: { deviceId } });
    }
    if (!row || row.revokedAt) return null;
    const prevSeen = row.lastSeenAt;
    if (touch) {
      // 网页端顺便记一下是哪个浏览器（设备列表里显示用）
      const setLabel = row.kind === 'web' && label && label !== row.label ? { label: label.slice(0, 30) } : {};
      await this.prisma.userDevice.update({ where: { id: row.id }, data: { lastSeenAt: new Date(), ...setLabel } });
    }
    return { userId: row.userId, did: row.id, prevSeen };
  }

  /** 把一台设备挂到账号上（注册 / 刷脸找回 / 并号）。超过上限时顶掉最久没用的，返回被顶掉的设备行 id */
  async attach(userId: bigint, deviceId: string, via: 'register' | 'recover' | 'merge', label = ''): Promise<{ did: bigint; kicked: bigint[] }> {
    await this.ensureOriginal(userId);
    const now = new Date();
    const data = { userId, kind: deviceKind(deviceId), label: label.slice(0, 30), via, revokedAt: null, createdAt: now, lastSeenAt: now };
    const row = await this.prisma.userDevice.upsert({ where: { deviceId }, create: { deviceId, ...data }, update: data });
    await this.redis.client.del(deviceDeadKey(row.id));
    // 这台设备如果是别的账号注册时用的那台，把那个账号上的设备号让出来
    await this.release(deviceId, userId);

    const active = await this.prisma.userDevice.findMany({ where: { userId, revokedAt: null }, orderBy: { lastSeenAt: 'asc' } });
    const kicked: bigint[] = [];
    for (const old of active) {
      if (active.length - kicked.length <= MAX_DEVICES) break;
      if (old.id === row.id) continue;
      await this.revokeRow(old);
      kicked.push(old.id);
    }
    return { did: row.id, kicked };
  }

  /** 能登录这个账号的设备（正在用的排最前） */
  async list(userId: bigint, currentDid?: bigint): Promise<DeviceView[]> {
    await this.ensureOriginal(userId);
    const rows = await this.prisma.userDevice.findMany({ where: { userId, revokedAt: null }, orderBy: { lastSeenAt: 'desc' } });
    return rows
      .map((r) => ({ id: r.id.toString(), kind: r.kind, label: r.label, via: r.via, createdAt: r.createdAt, lastSeenAt: r.lastSeenAt, current: currentDid !== undefined && r.id === currentDid }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  }

  /** 移除一台设备：它马上退出登录，想再用要重新刷脸找回。不能移除正在用的这台。 */
  async remove(userId: bigint, id: bigint, currentDid?: bigint): Promise<bigint> {
    // 老的登录令牌里没有设备信息，分不清哪台是「本机」，怕把自己踢了：让客户端重新进一次再来
    if (currentDid === undefined) throw new BadRequestException({ message: '请重新打开 App 后再试', reason: 'need_relogin' });
    if (id === currentDid) throw new BadRequestException('不能移除正在用的这台设备');
    const row = await this.prisma.userDevice.findUnique({ where: { id } });
    if (!row || row.userId !== userId || row.revokedAt) throw new NotFoundException('设备不存在');
    await this.revokeRow(row);
    return row.id;
  }

  /** 上次用这台设备之后，有哪些新设备通过刷脸挂到了这个账号上（打开 App 时提醒一次） */
  async newSince(userId: bigint, did: bigint, since: Date) {
    const rows = await this.prisma.userDevice.findMany({
      where: { userId, revokedAt: null, id: { not: did }, via: { in: ['recover', 'merge'] }, createdAt: { gt: since } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ id: r.id.toString(), kind: r.kind, label: r.label, at: r.createdAt }));
  }

  /** 设备行 → 推给其它设备的简况 */
  async brief(did: bigint) {
    const r = await this.prisma.userDevice.findUnique({ where: { id: did } });
    return r ? { id: r.id.toString(), kind: r.kind, label: r.label, at: r.createdAt } : null;
  }

  /** 这个账号现在挂着的所有设备（并号时整体搬到老账号下） */
  async activeOf(userId: bigint): Promise<UserDevice[]> {
    await this.ensureOriginal(userId);
    return this.prisma.userDevice.findMany({ where: { userId, revokedAt: null }, orderBy: { lastSeenAt: 'asc' } });
  }

  /** 并号后作废的账号：让它已经发出去的登录令牌全部失效 */
  async killUser(userId: bigint) {
    await this.redis.client.set(userDeadKey(userId), '1', 'EX', DEAD_TTL_SEC);
  }

  /**
   * 把「注册时用的设备号」从账号上让出来（改成一个带 ~ 的占位值）。
   * 用在：设备被移除、或者挪到了别的账号下。不让出来的话，这台设备以后没法重新注册（device_id 唯一）。
   * exceptUserId：这个账号除外（设备现在就挂在它下面）。
   */
  async release(deviceId: string, exceptUserId?: bigint) {
    const holder = await this.prisma.user.findUnique({ where: { deviceId }, select: { id: true } });
    if (!holder || holder.id === exceptUserId) return;
    await this.prisma.user.update({ where: { id: holder.id }, data: { deviceId: `${deviceId.slice(0, 48)}~${holder.id}.${Date.now().toString(36)}` } });
  }

  /** 给注册时的那台设备在设备表里补一行（设备表上线前注册的账号没有） */
  private async ensureOriginal(userId: bigint) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { deviceId: true, createdAt: true, updatedAt: true } });
    // 带 ~ 的是已经让出来的占位值，不是真的设备号
    if (!u || u.deviceId.includes('~')) return;
    const has = await this.prisma.userDevice.findUnique({ where: { deviceId: u.deviceId }, select: { id: true } });
    if (has) return;
    try {
      await this.prisma.userDevice.create({
        data: { userId, deviceId: u.deviceId, kind: deviceKind(u.deviceId), via: 'register', createdAt: u.createdAt, lastSeenAt: u.updatedAt },
      });
    } catch (e) {
      // 两个请求同时补：另一个已经补上了
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }

  private async revokeRow(row: UserDevice) {
    await this.prisma.userDevice.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    await this.redis.client.set(deviceDeadKey(row.id), '1', 'EX', DEAD_TTL_SEC);
    await this.release(row.deviceId);
  }
}
