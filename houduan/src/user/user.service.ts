import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { UpdateProfileDto } from './user.dto';
import { HnService } from '../hn/hn.service';
import { profileDone } from '../common/need-profile';

/** 18 位身份证号校验（GB 11643-1999 校验位算法），无需第三方接口 */
export function validIdCard(id: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  const sum = weights.reduce((acc, w, i) => acc + w * Number(id[i]), 0);
  if (codes[sum % 11] !== id[17].toUpperCase()) return false;
  // 出生日期合法性
  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const date = new Date(y, m - 1, d);
  return y >= 1900 && y <= new Date().getFullYear() &&
    date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly registry: ConnectionRegistry,
    private readonly hn: HnService,
  ) {}

  async getMe(userId: bigint) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { albums: { orderBy: { sort: 'asc' } } },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const [following, fans, done, prof, deepSession] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.prisma.follow.count({ where: { targetId: userId } }),
      profileDone(this.prisma, userId),
      this.prisma.profile.findUnique({ where: { userId }, select: { deepConfirmedAt: true } }),
      this.prisma.deepSession.findFirst({ where: { userId }, orderBy: { id: 'desc' }, select: { status: true } }),
    ]);
    return {
      ...this.auth.toProfile(user),
      /** 是否已完成资料收集（相亲画像已确认）；没完成不能主动发起聊天 */
      profileDone: done,
      /** AI 深聊：none 没聊过 | chatting 聊到一半 | draft 画像等确认 | done 已确认 */
      deepStatus: prof?.deepConfirmedAt && (!deepSession || deepSession.status === 'done') ? 'done' : (deepSession?.status ?? 'none'),
      following,
      fans,
      albums: user.albums,
    };
  }

  /** 关注/取关 toggle */
  async toggleFollow(userId: bigint, targetId: bigint) {
    if (userId === targetId) throw new ForbiddenException('不能关注自己');
    const target = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!target || target.status !== 0) throw new NotFoundException('用户不存在');

    const existing = await this.prisma.follow.findUnique({
      where: { followerId_targetId: { followerId: userId, targetId } },
    });
    if (existing) {
      await this.prisma.follow.delete({ where: { id: existing.id } });
      return { following: false };
    }
    await this.prisma.follow.create({ data: { followerId: userId, targetId } });
    return { following: true };
  }

  async listFollows(userId: bigint, type: 'following' | 'fans') {
    const rows = await this.prisma.follow.findMany({
      where: type === 'following' ? { followerId: userId } : { targetId: userId },
      orderBy: { id: 'desc' },
      take: 100,
    });
    const ids = rows.map((r) => (type === 'following' ? r.targetId : r.followerId));
    if (ids.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, nickname: true, avatar: true, age: true, gender: true, cityName: true, signature: true, isGuide: true },
    });
    const map = new Map(users.map((u) => [u.id.toString(), u]));
    return ids.map((id) => map.get(id.toString())).filter(Boolean);
  }

  async updateProfile(userId: bigint, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { ...dto } });
    return this.auth.toProfile(user);
  }

  /**
   * 遇见列表（主页「遇见」tab）：异性用户卡片流。
   * tab=all 综合（评分优先）| new 新人（注册倒序）| city 同城 | intimacy 亲密度倒序。
   */
  async meetList(viewerId: bigint, tab: string, city?: string) {
    const viewer = await this.prisma.user.findUnique({ where: { id: viewerId } });
    if (!viewer) throw new NotFoundException('用户不存在');
    // 全局性别隔离：仅可见异性
    const baseWhere = { gender: viewer.gender === 1 ? 2 : 1, status: 0, hidden: false, id: { not: viewerId } };
    const select = {
      id: true, nickname: true, avatar: true, gender: true, age: true, cityName: true,
      isGuide: true, realStatus: true, ratingAvg: true, ratingCount: true, createdAt: true, allowVideo: true,
    } as const;

    let users: any[];
    if (tab === 'intimacy') {
      // 只列与我有过互动的人，按我的亲密度倒序
      const rows = await this.prisma.intimacy.findMany({
        where: { userId: viewerId, score: { gt: 0 } },
        orderBy: { score: 'desc' },
        take: 60,
      });
      const found = await this.prisma.user.findMany({
        where: { ...baseWhere, id: { in: rows.map((r) => r.peerId) } },
        select,
      });
      const byId = new Map(found.map((u) => [u.id.toString(), u]));
      users = rows.map((r) => byId.get(r.peerId.toString())).filter(Boolean);
    } else if (tab === 'new') {
      users = await this.prisma.user.findMany({ where: baseWhere, orderBy: { id: 'desc' }, take: 60, select });
    } else if (tab === 'city') {
      const target = (city || viewer.cityName || '').trim();
      users = target
        ? await this.prisma.user.findMany({
            where: { ...baseWhere, cityName: target },
            orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
            take: 60,
            select,
          })
        : [];
    } else {
      users = await this.prisma.user.findMany({
        where: baseWhere,
        orderBy: [{ ratingAvg: 'desc' }, { id: 'desc' }],
        take: 60,
        select,
      });
    }
    if (users.length === 0) return [];

    const ids = users.map((u) => u.id);
    const [onlineSet, busyRows, intimacyRows, likeRows] = await Promise.all([
      this.registry.onlineSet(ids),
      // 占线：进行中或 90 秒内呼叫中的通话
      this.prisma.callRecord.findMany({
        where: {
          AND: [
            { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
            { OR: [{ callerId: { in: ids } }, { calleeId: { in: ids } }] },
          ],
        },
        select: { callerId: true, calleeId: true },
      }),
      this.prisma.intimacy.findMany({ where: { userId: viewerId, peerId: { in: ids } } }),
      // 我和这些人的喜欢关系（卡片上的 ♥ 按它显示）
      this.prisma.matchAction.findMany({
        where: { kind: 'like', OR: [{ userId: viewerId, targetId: { in: ids } }, { targetId: viewerId, userId: { in: ids } }] },
        select: { userId: true, targetId: true },
      }),
    ]);
    const iLike = new Set(likeRows.filter((r) => r.userId === viewerId).map((r) => r.targetId.toString()));
    const likesMe = new Set(likeRows.filter((r) => r.userId !== viewerId).map((r) => r.userId.toString()));
    const busySet = new Set<string>();
    for (const r of busyRows) {
      busySet.add(r.callerId.toString());
      busySet.add(r.calleeId.toString());
    }
    const intimacyMap = new Map(intimacyRows.map((r) => [r.peerId.toString(), r.score]));
    const newSince = Date.now() - 7 * 86400_000;

    return users.map((u) => ({
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      gender: u.gender,
      age: u.age,
      cityName: u.cityName,
      isGuide: u.isGuide,
      realnameVerified: u.realStatus === 1,
      // 0-100 缓存分，客户端换算五星显示
      ratingAvg: u.ratingAvg,
      ratingCount: u.ratingCount,
      /** 对方打开了视频见面（默认关）；没打开就不显示视频按钮 */
      allowVideo: u.allowVideo,
      online: onlineSet.has(u.id.toString()),
      busy: busySet.has(u.id.toString()),
      /** 注册 7 天内 = 新人徽章 */
      isNew: u.createdAt.getTime() > newSince,
      /** 与我的亲密度（分，含 0.5 粒度） */
      intimacy: (intimacyMap.get(u.id.toString()) ?? 0) / 10,
      /** none 都没表态 | liked 我喜欢了 | likedMe 对方喜欢了我 | mutual 互相喜欢 */
      like: iLike.has(u.id.toString()) ? (likesMe.has(u.id.toString()) ? 'mutual' : 'liked') : likesMe.has(u.id.toString()) ? 'likedMe' : 'none',
    }));
  }

  /** 照片墙整组保存：删旧建新，按数组顺序排序（最多 8 张，DTO 已限制） */
  async updateAlbums(userId: bigint, photos: string[]) {
    await this.prisma.$transaction([
      this.prisma.userAlbum.deleteMany({ where: { userId, type: 1 } }),
      this.prisma.userAlbum.createMany({
        data: photos.map((url, i) => ({ userId, type: 1, url: String(url).slice(0, 255), sort: i })),
      }),
    ]);
    return { ok: true, count: photos.length };
  }

  /**
   * 实名认证（仅女生）：本地校验身份证格式 + 校验位 + 出生日期，
   * 一证一号（证号全局唯一），通过即认证成功。
   */
  /**
   * 【已停用】旧的免费实名（只验校验位、明文落库）。M1 改为实人认证（身份证 + 刷脸，走 /kyc/*），
   * 这个入口不再写任何明文，直接拒绝，避免老客户端或接口调用往库里写证号明文。
   */
  async verifyRealname(_userId: bigint, _name: string, _idCard: string) {
    throw new BadRequestException('实名方式已升级为实人认证，请在完善资料里完成');
  }

  /** GPS 位置上报 */
  async reportLocation(userId: bigint, latitude?: number, longitude?: number) {
    if (latitude == null || longitude == null) return { ok: false };
    // 审核演示账号位置固定成都，不接受客户端上报覆盖
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { deviceId: true } });
    if (me?.deviceId?.startsWith('demo_')) return { ok: true };
    await this.prisma.user.update({ where: { id: userId }, data: { latitude, longitude } });
    return { ok: true };
  }

  async getProfile(viewerId: bigint, targetId: bigint) {
    const [viewer, target] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: viewerId } }),
      this.prisma.user.findUnique({ where: { id: targetId }, include: { albums: { orderBy: { sort: 'asc' } } } }),
    ]);
    if (!target || target.status !== 0) throw new NotFoundException('用户不存在');
    // 全局性别隔离：仅异性可见
    if (viewer && viewer.gender === target.gender && viewerId !== targetId) {
      throw new ForbiddenException('无法查看该用户');
    }
    const [following, fans, followRow] = await Promise.all([
      this.prisma.follow.count({ where: { followerId: targetId } }),
      this.prisma.follow.count({ where: { targetId } }),
      this.prisma.follow.findUnique({ where: { followerId_targetId: { followerId: viewerId, targetId } } }),
    ]);

    // 女生附带评分与视频接通率（在线时收到的视频邀请中实际接通的比例）
    let rating: {
      avg: number; count: number;
      photo: number; obedience: number; legs: number; chest: number; skin: number;
    } | null = null;
    let answerRate: number | null = null;
    if (target.gender === 2) {
      // 五维度均分（0-100），供主页评分面板展示
      const dims = await this.prisma.callRating.aggregate({
        where: { femaleId: targetId },
        _avg: { photo: true, obedience: true, legs: true, chest: true, skin: true },
      });
      rating = {
        avg: target.ratingAvg,
        count: target.ratingCount,
        photo: Math.round(dims._avg.photo ?? 0),
        obedience: Math.round(dims._avg.obedience ?? 0),
        legs: Math.round(dims._avg.legs ?? 0),
        chest: Math.round(dims._avg.chest ?? 0),
        skin: Math.round(dims._avg.skin ?? 0),
      };
      const [total, connected] = await Promise.all([
        this.prisma.callRecord.count({ where: { calleeId: targetId, type: 2, status: { in: [1, 2, 3, 4] } } }),
        this.prisma.callRecord.count({ where: { calleeId: targetId, type: 2, status: { in: [1, 2] } } }),
      ]);
      answerRate = total > 0 ? Math.round((connected / total) * 100) : -1; // -1=暂无数据
    }

    // 在线与占线状态（视频通话按钮三态：可打 / 通话中 / 离线）
    const [online, matchProfile, busyRow] = await Promise.all([
      this.registry.isOnline(targetId),
      // 相亲资料卡：对方完成资料收集后才有（不含收入）
      this.hn.publicCard(targetId, target.gender),
      this.prisma.callRecord.findFirst({
        where: {
          AND: [
            { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
            { OR: [{ callerId: targetId }, { calleeId: targetId }] },
          ],
        },
        select: { id: true },
      }),
    ]);

    return {
      ...this.auth.toProfile(target),
      following,
      fans,
      isFollowing: !!followRow,
      albums: target.albums,
      rating,
      answerRate,
      matchProfile,
      online,
      busy: !!busyRow,
      realnameVerified: target.realStatus === 1,
    };
  }
}
