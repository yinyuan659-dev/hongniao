import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import type { WebSocket } from 'ws';
import { ConnectionRegistry } from './connection.registry';
import { ImService } from './im.service';
import { ReadFrame, SendFrame } from './im.types';
import { langOf, translate } from '../i18n/translate';
import { NEED_PROFILE_CODE, NeedProfileException } from '../common/need-profile';
import { NEED_KYC_CODE, NeedKycException } from '../common/kyc-gate';
import { ChatGateException } from '../common/chat-gate';
import { GroupGateException } from './group.service';

@WebSocketGateway({ path: '/ws', maxPayload: 128 * 1024 })
export class ImGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('ImGateway');
  private readonly socketUser = new WeakMap<WebSocket, bigint>();
  /** 连接时 ?lang= 带上来的界面语言，错误帧按它翻译（null = 中文） */
  private readonly socketLang = new WeakMap<WebSocket, string | null>();
  /** 每连接帧率窗口：秒级时间戳 + 该秒内帧数 */
  private readonly frameRate = new WeakMap<WebSocket, { sec: number; count: number }>();

  private static readonly MAX_CONN_PER_USER = 8;
  private static readonly MAX_FRAMES_PER_SEC = 25;
  private static readonly MAX_CONTENT_LEN = 8000;

  constructor(
    private readonly jwt: JwtService,
    private readonly registry: ConnectionRegistry,
    private readonly im: ImService,
  ) {}

  async handleConnection(ws: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '', 'http://localhost');
    const token = url.searchParams.get('token');
    let userId: bigint;
    let did = '';
    try {
      const payload = this.jwt.verify(token ?? '');
      userId = BigInt(payload.sub);
      did = payload.did ? String(payload.did) : '';
    } catch {
      ws.close(4001, 'unauthorized');
      return;
    }
    // 这台设备被移除了、或者这个号并号后作废了：令牌没过期也不让连
    if (await this.registry.isDead(userId.toString(), did)) {
      ws.close(4001, 'unauthorized');
      return;
    }

    // 单用户连接数上限：防止单账号占满服务器连接
    if (this.registry.localCount(userId) >= ImGateway.MAX_CONN_PER_USER) {
      ws.close(4009, 'too many connections');
      return;
    }

    this.socketUser.set(ws, userId);
    this.socketLang.set(ws, langOf(url.searchParams.get('lang') ?? undefined));
    await this.registry.register(userId, ws, did || undefined);

    ws.on('message', (raw: Buffer) => this.onFrame(ws, userId, raw));
  }

  async handleDisconnect(ws: WebSocket) {
    const userId = this.socketUser.get(ws);
    if (userId !== undefined) {
      await this.registry.unregister(userId, ws);
    }
  }

  private async onFrame(ws: WebSocket, userId: bigint, raw: Buffer) {
    // 每连接帧率限制：刷帧直接断开
    const now = Math.floor(Date.now() / 1000);
    const rate = this.frameRate.get(ws);
    if (rate?.sec === now) {
      if (++rate.count > ImGateway.MAX_FRAMES_PER_SEC) {
        ws.close(4008, 'rate limited');
        return;
      }
    } else {
      this.frameRate.set(ws, { sec: now, count: 1 });
    }

    let frame: any;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      switch (frame.op) {
        case 'ping':
          ws.send(JSON.stringify({ op: 'pong' }));
          break;
        case 'send': {
          const f = frame as SendFrame;
          delete f.fwdFrom;
          if (!f.targetId || !f.msgType || typeof f.content !== 'string') return;
          if (f.content.length > ImGateway.MAX_CONTENT_LEN) return;
          const payload = await this.im.sendMessage(userId, f);
          ws.send(
            JSON.stringify({
              op: 'ack',
              tempId: f.tempId,
              msgId: payload.id,
              conversationId: payload.conversationId,
              createdAt: payload.createdAt,
            }),
          );
          break;
        }
        case 'read': {
          const f = frame as ReadFrame;
          if (!f.conversationId || !f.msgId) return;
          await this.im.markRead(userId, BigInt(f.conversationId), BigInt(f.msgId));
          break;
        }
      }
    } catch (e: any) {
      ws.send(JSON.stringify({
        op: 'error',
        tempId: frame?.tempId,
        msg: translate(e?.message ?? '操作失败', this.socketLang.get(ws) ?? null),
        // 没完成资料收集：客户端按 code 弹「去完成」，不靠文字判断（文字会被翻译）
        // 没互相喜欢 / 对方已结束聊天：code 是 need_like / chat_ended
        // 群用不了：code 是 group_left / group_dissolved / group_closed
        ...(e instanceof NeedProfileException ? { code: NEED_PROFILE_CODE } : e instanceof NeedKycException ? { code: NEED_KYC_CODE } : e instanceof ChatGateException || e instanceof GroupGateException ? { code: e.code } : {}),
      }));
    }
  }
}
