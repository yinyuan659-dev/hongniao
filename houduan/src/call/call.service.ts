import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionRegistry } from '../im/connection.registry';
import { ImService } from '../im/im.service';
import { IntimacyService } from '../intimacy/intimacy.service';
import { SrsEndpoint, SrsService } from '../srs/srs.service';
import { NeedProfileException, profileDone } from '../common/need-profile';
import { assertCanChat } from '../common/chat-gate';
import { assertKyc } from '../common/kyc-gate';

/** 掉线检查间隔（毫秒） */
const WATCH_TICK_MS = 60_000;
/** 双方连续 N 次检查都有人离线则强制挂断（防异常掉线一直占线） */
const OFFLINE_STRIKE_LIMIT = 2;

/**
 * 一对一音视频通话信令（媒体走 SRS WebRTC）：
 * 流命名 live/{callId}_{userId}，双方各推自己的流、拉对方的流。
 * WHIP 推流: {节点地址}/rtc/v1/whip/?app=live&stream={callId}_{userId}
 * WHEP 拉流: {节点地址}/rtc/v1/whep/?app=live&stream={callId}_{peerId}
 * 节点地址现在是 https://gphnai.com（nginx 转给 SRS，见 SrsService.endpoint）；媒体仍然直连 SRS 的 UDP 8000。
 * 信令帧经 IM WebSocket 下发：{ op: "call", event, data }
 *
 * 通话不收费（相亲全程 0 收费，开发文档 §1）。视频见面默认关闭：
 * 自己和对方都在「我的」里打开「视频见面」（user.allowVideo）后才能发起（开发文档 §3.5）。
 */
@Injectable()
export class CallService implements OnModuleInit, OnModuleDestroy {
  private readonly srsServer: string;
  private readonly srsApi: string;
  private readonly logger = new Logger('Call');
  private watchTimer?: NodeJS.Timeout;
  /** 双方离线连击计数（连续 OFFLINE_STRIKE_LIMIT 次强制挂断） */
  private readonly offlineStrikes = new Map<string, number>();

  onModuleInit() {
    this.watchTimer = setInterval(() => {
      this.watchTick().catch((e) => this.logger.error(`掉线检查异常: ${e?.stack ?? e}`));
    }, WATCH_TICK_MS);
  }

  onModuleDestroy() {
    if (this.watchTimer) clearInterval(this.watchTimer);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionRegistry,
    private readonly im: ImService,
    private readonly intimacy: IntimacyService,
    private readonly srs: SrsService,
    config: ConfigService,
  ) {
    this.srsServer = config.get<string>('SRS_SERVER') ?? '';
    this.srsApi = config.get<string>('SRS_API') ?? '';
  }

  /**
   * 通话参数（后台可调：分辨率/帧率/码率）+ 媒体入口。
   * endpoint 不传时用环境变量 SRS（/call/config 只读展示用）；真正通话的节点在 invite 时按负载分配。
   */
  async getConfig(endpoint?: SrsEndpoint) {
    const cfg = await this.prisma.callConfig.findFirst();
    const ep = endpoint ?? {
      srsServer: this.srsServer,
      whipUrl: `${this.srsApi}/rtc/v1/whip/`,
      whepUrl: `${this.srsApi}/rtc/v1/whep/`,
    };
    return {
      width: cfg?.width ?? 640,
      height: cfg?.height ?? 480,
      fps: cfg?.fps ?? 25,
      bitrate: cfg?.bitrate ?? 800,
      srsServer: ep.srsServer,
      whipUrl: ep.whipUrl,
      whepUrl: ep.whepUrl,
    };
  }

  async invite(callerId: bigint, calleeId: bigint, type: 1 | 2) {
    if (callerId === calleeId) throw new BadRequestException('无法呼叫自己');
    const [caller, callee] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: callerId } }),
      this.prisma.user.findUnique({ where: { id: calleeId } }),
    ]);
    if (!callee || callee.status !== 0) throw new NotFoundException('对方不存在');
    if (!caller || caller.gender === callee.gender) throw new ForbiddenException('无法呼叫该用户');
    // 和聊天一样：没完成资料收集不能主动发起
    if (!(await profileDone(this.prisma, callerId))) throw new NeedProfileException('完成资料收集后才能发起通话');
    // 和聊天一样：互相喜欢后才能打（规则上线前就聊过的有保留期）
    await assertCanChat(this.prisma, callerId, calleeId);
    // 和聊天一样：做过实人认证才能打（后台开关控制，默认关）
    await assertKyc(this.prisma, callerId);
    // 视频见面默认关闭，双方都打开才能打
    if (type === 2) {
      if (!caller.allowVideo) throw new BadRequestException('你还没有打开视频见面，请先到「我的」里打开');
      if (!callee.allowVideo) throw new BadRequestException('对方没有打开视频见面');
    }

    // 对方不在线直接提示，不进入等待接听
    if (!(await this.registry.isOnline(calleeId))) {
      throw new BadRequestException('对方不在线，无法接通');
    }

    // 占线检查：任一方有进行中的通话则拒绝（呼叫中记录 90 秒内有效，防止异常退出永久占线）
    const busySet = await this.busySet([callerId, calleeId]);
    if (busySet.has(calleeId.toString())) throw new BadRequestException('对方正在通话中');
    if (busySet.has(callerId.toString())) throw new BadRequestException('您正在通话中');

    const callId = randomUUID().replace(/-/g, '');
    // 按各节点负载分配 SRS，记在通话记录上：双方（含接听时）拿到同一节点
    const endpoint = await this.srs.pick(`call ${callId}`);
    const record = await this.prisma.callRecord.create({
      data: { callId, callerId, calleeId, type, status: 0, srsNode: endpoint.srsServer },
    });
    this.logger.log(`invite: callId=${callId} type=${type} srs=${endpoint.srsServer || '(env)'}`);

    const config = await this.getConfig(endpoint);
    await this.registry.deliver([calleeId], {
      op: 'call',
      event: 'invite',
      data: {
        callId,
        type,
        caller: { id: caller.id.toString(), nickname: caller.nickname, avatar: caller.avatar },
        config,
      },
    });
    return { callId, config, record: { id: record.id } };
  }

  async accept(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) throw new BadRequestException('通话状态已变更');

    await this.prisma.callRecord.update({
      where: { callId },
      data: { status: 1, startedAt: new Date() },
    });
    // 与 invite 同一节点
    const config = await this.getConfig(await this.srs.endpointFor(record.srsNode));
    await this.registry.deliver([record.callerId], { op: 'call', event: 'accept', data: { callId } });
    return { callId, config };
  }

  async reject(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) return { ok: true };
    await this.prisma.callRecord.update({ where: { callId }, data: { status: 4, endedAt: new Date() } });
    await this.registry.deliver([record.callerId], { op: 'call', event: 'reject', data: { callId } });
    await this.im.sendCallMessage(record.callerId, record.calleeId, JSON.stringify({ callType: record.type, result: 'reject' }));
    return { ok: true };
  }

  /** 主叫在对方未接听时取消 */
  async cancel(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 0) return { ok: true };
    await this.prisma.callRecord.update({ where: { callId }, data: { status: 5, endedAt: new Date() } });
    await this.registry.deliver([record.calleeId], { op: 'call', event: 'cancel', data: { callId } });
    await this.im.sendCallMessage(record.callerId, record.calleeId, JSON.stringify({ callType: record.type, result: 'cancel' }));
    return { ok: true };
  }

  /**
   * 任一方挂断。
   * opts.reason：强制挂断原因（连接中断），随 end 信令下发；
   * opts.notifyBoth：true 时双方都收 end 信令（服务端强制挂断场景）。
   */
  async end(userId: bigint, callId: string, opts?: { reason?: string; notifyBoth?: boolean }) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('无权操作');
    if (record.status !== 1 && record.status !== 0) return { ok: true };
    const wasActive = record.status === 1;
    const endedAt = new Date();
    const durationSec = record.startedAt ? Math.floor((endedAt.getTime() - record.startedAt.getTime()) / 1000) : 0;
    await this.prisma.callRecord.update({
      where: { callId },
      data: { status: wasActive ? 2 : 3, endedAt, durationSec },
    });
    this.offlineStrikes.delete(callId);

    // 亲密度：视频每分钟主叫 +1、被叫 +0.5（不足 1 分钟按 1 分钟）
    if (wasActive && record.type === 2 && durationSec > 0) {
      void this.intimacy.bump(record.callerId, record.calleeId, Math.max(1, Math.ceil(durationSec / 60)));
    }

    const peer = record.callerId === userId ? record.calleeId : record.callerId;
    const targets = opts?.notifyBoth ? [record.callerId, record.calleeId] : [peer];
    await this.registry.deliver(targets, {
      op: 'call',
      event: 'end',
      data: { callId, durationSec, ...(opts?.reason ? { reason: opts.reason } : {}) },
    });
    await this.im.sendCallMessage(
      record.callerId,
      record.calleeId,
      JSON.stringify(wasActive ? { callType: record.type, result: 'end', duration: durationSec } : { callType: record.type, result: 'cancel' }),
    );
    if (opts?.reason) this.logger.log(`强制挂断完成: callId=${callId} reason=${opts.reason} duration=${durationSec}s`);
    return { ok: true, durationSec };
  }

  /** 掉线检查（每分钟）：通话中任一方连续 OFFLINE_STRIKE_LIMIT 次不在线 → 强制挂断，避免一直占线 */
  private async watchTick() {
    const active = await this.prisma.callRecord.findMany({ where: { status: 1 } });
    if (!active.length) return;

    // 批量在线检查（一次 Redis 查询）
    const online = await this.registry.onlineSet(active.flatMap((r) => [r.callerId, r.calleeId]));
    for (const r of active) {
      try {
        const offline = [r.callerId.toString(), r.calleeId.toString()].filter((id) => !online.has(id));
        if (offline.length > 0) {
          const strikes = (this.offlineStrikes.get(r.callId) ?? 0) + 1;
          this.offlineStrikes.set(r.callId, strikes);
          this.logger.warn(`离线: callId=${r.callId} offline=[${offline.join(',')}] strikes=${strikes}/${OFFLINE_STRIKE_LIMIT}`);
          if (strikes >= OFFLINE_STRIKE_LIMIT) {
            await this.end(r.callerId, r.callId, { reason: '连接中断，通话已结束', notifyBoth: true });
          }
        } else if (this.offlineStrikes.has(r.callId)) {
          this.offlineStrikes.delete(r.callId);
        }
      } catch (e: any) {
        this.logger.error(`掉线检查处理通话异常: callId=${r.callId} err=${e?.stack ?? e}`);
      }
    }
  }

  /**
   * 一方推流完成的通知：转发给对方，对方收到后才开始 WHEP 订阅。
   * SRS 会接受"发布者尚未推流"的订阅（ICE 也通）但之后永远不转发 RTP，
   * 必须保证订阅晚于发布。
   */
  async published(userId: bigint, callId: string) {
    const record = await this.mustCall(callId);
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('无权操作');
    const peer = record.callerId === userId ? record.calleeId : record.callerId;
    await this.registry.deliver([peer], { op: 'call', event: 'published', data: { callId } });
    return { ok: true };
  }

  private async mustCall(callId: string) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId } });
    if (!record) throw new NotFoundException('通话不存在');
    return record;
  }

  /**
   * 客户端通话日志上报：双端各自分批上报，后台按 callId 汇总排查媒体问题。
   * 仅通话参与方可上报；单批最多 500 行，超长行截断。
   */
  async appendLog(userId: bigint, dto: { callId: string; platform: string; lines: string[] }) {
    const record = await this.prisma.callRecord.findUnique({ where: { callId: dto.callId } });
    if (!record) throw new NotFoundException('通话不存在');
    if (record.callerId !== userId && record.calleeId !== userId) throw new ForbiddenException('非通话参与方');
    const content = dto.lines.slice(0, 500).map((l) => String(l).slice(0, 500)).join('\n');
    if (!content) return { ok: true };
    await this.prisma.callClientLog.create({
      data: { callId: dto.callId, uid: userId, platform: dto.platform.slice(0, 10), content },
    });
    return { ok: true };
  }

  /**
   * 视频通话结束后男方对女方评分：5 维度各 0-100，平均分为最终得分。
   * 一次通话只能评一次；评完刷新女方评分缓存（影响广场推荐排序）。
   */
  async rate(userId: bigint, dto: { callId: string; photo: number; obedience: number; legs: number; chest: number; skin: number }) {
    const record = await this.mustCall(dto.callId);
    if (record.callerId !== userId) throw new ForbiddenException('仅发起方可评分');
    if (record.type !== 2) throw new BadRequestException('仅视频通话可评分');
    if (record.status !== 2 || record.durationSec <= 0) throw new BadRequestException('通话未接通，无法评分');

    const avg = Math.round((dto.photo + dto.obedience + dto.legs + dto.chest + dto.skin) / 5);
    try {
      await this.prisma.callRating.create({
        data: {
          callId: dto.callId,
          maleId: record.callerId,
          femaleId: record.calleeId,
          photo: dto.photo,
          obedience: dto.obedience,
          legs: dto.legs,
          chest: dto.chest,
          skin: dto.skin,
          avg,
        },
      });
    } catch {
      throw new BadRequestException('该通话已评过分');
    }

    // 刷新女方评分缓存
    const agg = await this.prisma.callRating.aggregate({
      where: { femaleId: record.calleeId },
      _avg: { avg: true },
      _count: true,
    });
    await this.prisma.user.update({
      where: { id: record.calleeId },
      data: { ratingAvg: Math.round(agg._avg.avg ?? 0), ratingCount: agg._count },
    });
    return { ok: true, avg };
  }

  /**
   * 批量查询用户占线状态：进行中（status=1）或 90 秒内的呼叫中（status=0）算占线。
   * 返回占线用户 id 字符串集合。
   */
  async busySet(userIds: bigint[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.prisma.callRecord.findMany({
      where: {
        AND: [
          { OR: [{ status: 1 }, { status: 0, createdAt: { gt: new Date(Date.now() - 90_000) } }] },
          { OR: [{ callerId: { in: userIds } }, { calleeId: { in: userIds } }] },
        ],
      },
      select: { callerId: true, calleeId: true },
    });
    const set = new Set<string>();
    const idSet = new Set(userIds.map((i) => i.toString()));
    for (const r of rows) {
      if (idSet.has(r.callerId.toString())) set.add(r.callerId.toString());
      if (idSet.has(r.calleeId.toString())) set.add(r.calleeId.toString());
    }
    return set;
  }

  /** 女生视频接通率：在线时收到的视频邀请中实际接通的比例 */
  async answerRate(femaleId: bigint) {
    const [total, connected] = await Promise.all([
      this.prisma.callRecord.count({ where: { calleeId: femaleId, type: 2, status: { in: [1, 2, 3, 4] } } }),
      this.prisma.callRecord.count({ where: { calleeId: femaleId, type: 2, status: { in: [1, 2] } } }),
    ]);
    return { total, connected, rate: total > 0 ? Math.round((connected / total) * 100) : 0 };
  }
}
