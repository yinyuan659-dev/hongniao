import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  /** 登录：同一 IP+账号失败 5 次锁 15 分钟；哈希恒时比较防时序探测 */
  async login(username: string, password: string, ip = '') {
    const failKey = `admin:fail:${ip}:${username}`;
    const fails = Number(await this.redis.client.get(failKey)) || 0;
    if (fails >= 5) throw new UnauthorizedException('失败次数过多，请 15 分钟后再试');

    const admin = await this.prisma.adminUser.findUnique({ where: { username } });
    let ok = false;
    if (admin) {
      const [salt, hash] = admin.passwordHash.split(':');
      const check = crypto.scryptSync(password, salt, 32);
      const expect = Buffer.from(hash, 'hex');
      ok = check.length === expect.length && crypto.timingSafeEqual(check, expect);
    }
    if (!admin || !ok) {
      await this.redis.client.multi().incr(failKey).expire(failKey, 900).exec();
      throw new UnauthorizedException('账号或密码错误');
    }
    await this.redis.client.del(failKey);
    return { token: this.jwt.sign({ sub: admin.id.toString(), role: 'admin' }, { expiresIn: '7d' }) };
  }

  // ---------- 用户 ----------

  /**
   * 用户列表（分页，新的在前）：keyword 搜昵称 / 6 位 ID；
   * cat = normal 正常（默认，含已隐藏）/ male / female / guide 地陪（男女、正常的）/ hidden 已隐藏 / banned 已封禁 / all。
   * counts 是当前搜索下各分类的数量
   */
  async listUsers(keyword: string | undefined, cat: string | undefined, page: number, size: number) {
    const base = keyword ? { OR: [{ nickname: { contains: keyword } }, { shortId: keyword }] } : {};
    const CATS: Record<string, object> = {
      normal: { status: 0 },
      male: { status: 0, gender: 1 },
      female: { status: 0, gender: 2 },
      guide: { status: 0, isGuide: true },
      hidden: { hidden: true },
      banned: { status: { not: 0 } },
      all: {},
    };
    const c = cat && CATS[cat] ? cat : 'normal';
    size = Math.min(Math.max(Math.floor(size) || 20, 10), 100);
    page = Math.max(Math.floor(page) || 1, 1);
    const where = { ...base, ...CATS[c] };
    const [total, counts, list] = await Promise.all([
      this.prisma.user.count({ where }),
      Promise.all(Object.entries(CATS).map(async ([k, w]) => [k, await this.prisma.user.count({ where: { ...base, ...w } })] as const)).then(Object.fromEntries),
      this.prisma.user.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size }),
    ]);
    return { list, total, page, size, counts };
  }

  async setUserStatus(userId: bigint, status: number) {
    await this.prisma.user.update({ where: { id: userId }, data: { status } });
    return { ok: true };
  }

  /** 隐藏：不出现在 App 的遇见 / 找人 / 搜索用户 / 动态广场；聊天、关注照旧 */
  async setUserHidden(userId: bigint, hidden: boolean) {
    await this.prisma.user.update({ where: { id: userId }, data: { hidden } });
    return { hidden };
  }

  // ---------- 通话日志（排查视频/语音概率性问题） ----------

  /** 通话记录列表（游标分页），附双方昵称与日志条数 */
  async listCallLogs(beforeId?: bigint) {
    const records = await this.prisma.callRecord.findMany({
      where: beforeId ? { id: { lt: beforeId } } : undefined,
      orderBy: { id: 'desc' },
      take: 30,
    });
    const uids = [...new Set(records.flatMap((r) => [r.callerId, r.calleeId]))];
    const callIds = records.map((r) => r.callId);
    const [users, logCounts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, nickname: true, shortId: true, gender: true } }),
      this.prisma.callClientLog.groupBy({ by: ['callId'], where: { callId: { in: callIds } }, _count: true }),
    ]);
    const umap = new Map(users.map((u) => [u.id, u]));
    const cmap = new Map(logCounts.map((c) => [c.callId, c._count]));
    return records.map((r) => ({
      id: String(r.id),
      callId: r.callId,
      type: r.type,
      status: r.status,
      durationSec: r.durationSec,
      createdAt: r.createdAt,
      caller: umap.get(r.callerId) ?? null,
      callee: umap.get(r.calleeId) ?? null,
      logCount: cmap.get(r.callId) ?? 0,
    }));
  }

  /** 某通通话的全部日志（双端上报按时间排序） */
  async callLogDetail(callId: string) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId } });
    if (!record) throw new BadRequestException('通话不存在');
    const [logs, users] = await Promise.all([
      this.prisma.callClientLog.findMany({ where: { callId }, orderBy: { id: 'asc' } }),
      this.prisma.user.findMany({
        where: { id: { in: [record.callerId, record.calleeId] } },
        select: { id: true, nickname: true, shortId: true, gender: true },
      }),
    ]);
    return {
      record: {
        callId: record.callId,
        type: record.type,
        status: record.status,
        durationSec: record.durationSec,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        callerId: String(record.callerId),
        calleeId: String(record.calleeId),
      },
      users,
      logs: logs.map((l) => ({
        id: String(l.id),
        uid: String(l.uid),
        platform: l.platform,
        content: l.content,
        createdAt: l.createdAt,
      })),
    };
  }

  // ---------- 开关配置（price_config 表：现在只用「女生发动态要先实名」这一项，计费字段已不用） ----------

  async getPriceConfig() {
    const price = await this.prisma.priceConfig.findFirst();
    return price ?? { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2 };
  }

  async updatePriceConfig(data: { msgPriceFen?: number; videoBaseFenPerMin?: number; videoPlatformX?: number; momentNeedRealname?: boolean }) {
    const price = await this.prisma.priceConfig.findFirst();
    if (price) {
      return this.prisma.priceConfig.update({ where: { id: price.id }, data });
    }
    return this.prisma.priceConfig.create({ data: { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2, ...data } });
  }

  // ---------- 通话参数（后端可调核心） ----------

  async getCallConfig() {
    const cfg = await this.prisma.callConfig.findFirst();
    return cfg ?? { width: 640, height: 480, fps: 25, bitrate: 800 };
  }

  async updateCallConfig(data: { width?: number; height?: number; fps?: number; bitrate?: number }) {
    const cfg = await this.prisma.callConfig.findFirst();
    if (cfg) {
      return this.prisma.callConfig.update({ where: { id: cfg.id }, data });
    }
    return this.prisma.callConfig.create({ data: { width: 640, height: 480, fps: 30, bitrate: 800, ...data } });
  }

  // ---------- 模块入口管理（横幅项目 + 小游戏） ----------

  listModules() {
    return this.prisma.appModule.findMany({ orderBy: { sort: 'asc' } });
  }

  /**
   * type: native=客户端内置页（entry 为路由标识）；h5=横幅内嵌网页；game=小游戏（大厅宫格，图标+链接+说明）。
   * h5/game 的 entry 必须是 http(s) 完整地址，game 必须有图标；orientation 为游戏屏幕方向（portrait/landscape）。
   */
  upsertModule(data: {
    id?: number; name: string; nameEn?: string; icon?: string; desc?: string; descEn?: string; cover?: string; type: string; entry: string;
    orientation?: string; sort?: number; enabled?: boolean; visibleGender?: number;
  }) {
    if (!['native', 'h5', 'game'].includes(data.type)) throw new BadRequestException('type 非法');
    const entry = (data.entry ?? '').trim();
    if (!entry) throw new BadRequestException('入口不能为空');
    if (data.type !== 'native' && !/^https?:\/\//i.test(entry)) throw new BadRequestException('链接地址需以 http(s):// 开头');
    if (data.type === 'game' && !(data.icon ?? '').trim()) throw new BadRequestException('小游戏需上传图标');
    const orientation = data.orientation ?? 'portrait';
    if (!['portrait', 'landscape'].includes(orientation)) throw new BadRequestException('屏幕方向非法');
    const payload = {
      name: data.name,
      nameEn: (data.nameEn ?? '').trim().slice(0, 60),
      icon: data.icon ?? '',
      desc: data.desc ?? '',
      descEn: (data.descEn ?? '').trim().slice(0, 200),
      cover: data.cover ?? '',
      type: data.type,
      entry,
      orientation,
      sort: data.sort ?? 0,
      enabled: data.enabled ?? true,
      visibleGender: data.visibleGender ?? 0,
    };
    if (data.id) {
      return this.prisma.appModule.update({ where: { id: data.id }, data: payload });
    }
    return this.prisma.appModule.create({ data: payload });
  }

  // ---------- 动态管理 ----------

  async hideMoment(momentId: bigint) {
    await this.prisma.moment.update({ where: { id: momentId }, data: { status: 1 } });
    return { ok: true };
  }
}
