import { getToken } from './api';
import { lang } from './i18n';

export interface MessagePayload {
  id: string;
  conversationId: string;
  /** 1 单聊 2 群聊 */
  convType?: number;
  /** 群聊才有 */
  groupId?: string;
  groupName?: string;
  senderId: string;
  senderNickname: string;
  senderAvatar: string;
  receiverId: string | null;
  type: string;
  content: string;
  createdAt: string;
  replyTo?: ReplyPreview | null;
  fwdFrom?: string | null;
  reactions?: Reaction[];
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderNickname: string;
  type: string;
  content: string;
  deleted?: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  userIds: string[];
}

type Handler = (frame: any) => void;

/** IM WebSocket 管理：自动重连、心跳、监听分发 */
class WsManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private heartbeat: number | null = null;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private queue: string[] = [];
  /** 连上过没有：断线后重新连上时，告诉各页面补拉一次（平时的变化都靠推送，断线那段时间的会漏） */
  private everOpen = false;

  connect() {
    const token = getToken();
    if (!token || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.manualClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&lang=${lang()}`);

    this.ws.onopen = () => {
      this.heartbeat = window.setInterval(() => this.raw({ op: 'ping' }), 25000);
      const pending = this.queue;
      this.queue = [];
      pending.forEach((f) => this.ws?.send(f));
      // 不是服务器发来的帧：断线后重新连上了。页面收到它就把自己的数据重新拉一次
      if (this.everOpen) this.handlers.forEach((h) => h({ op: 'ws_reopen' }));
      this.everOpen = true;
    };
    this.ws.onmessage = (e) => {
      try {
        const frame = JSON.parse(e.data);
        this.handlers.forEach((h) => h(frame));
      } catch {}
    };
    this.ws.onclose = () => {
      if (this.heartbeat) window.clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      if (!this.manualClose) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 3000);
      }
    };
  }

  close() {
    this.manualClose = true;
    this.queue = [];
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  /**
   * 登录身份换了（刷脸找回、并号进了原来的账号）：断开旧连接，用新令牌重连。
   * 旧连接的回调先摘掉再关，免得它的 onclose 晚一步触发，把新连接的引用和心跳清掉。
   * 之前没连过（没人用聊天连接）就什么都不做，等用到时自己会连。
   */
  reconnect() {
    const old = this.ws;
    const wasActive = !!old || this.reconnectTimer !== null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      try { old.close(); } catch { /* 已经断了 */ }
    }
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.ws = null;
    if (wasActive) this.connect();
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** 发消息，返回 tempId。convType 1 = 单聊（targetId 是对方的用户 id），2 = 群聊（targetId 是群 id） */
  send(targetId: string, msgType: string, content: string, replyToId?: string, convType: 1 | 2 = 1): string {
    const tempId = `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.raw({ op: 'send', tempId, convType, targetId, msgType, content, ...(replyToId ? { replyToId } : {}) });
    return tempId;
  }

  /**
   * 等服务端确认这条消息（ack / error），最多 ms 毫秒。
   * 连发几条时要一条一条等：服务端并发处理同一连接的帧，连着发入库顺序不固定。
   */
  waitAck(tempId: string, ms = 8000): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (ok: boolean) => { off(); clearTimeout(timer); resolve(ok); };
      const off = this.on((f) => {
        if (f.tempId !== tempId) return;
        if (f.op === 'ack') done(true);
        else if (f.op === 'error') done(false);
      });
      const timer = setTimeout(() => done(false), ms);
    });
  }

  markRead(conversationId: string, msgId: string) {
    this.raw({ op: 'read', conversationId, msgId });
  }

  /** 没连上时 send / read 先排队，连上后补发（刚打开页面就发消息不会丢） */
  private raw(frame: { op: string; [k: string]: unknown }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    } else if (frame.op !== 'ping' && this.queue.length < 50) {
      this.queue.push(JSON.stringify(frame));
      this.connect();
    }
  }
}

export const wsManager = new WsManager();
