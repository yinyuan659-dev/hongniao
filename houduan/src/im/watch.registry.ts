import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

/**
 * 谁正停在某一类页面上（现在只有 trip：旅行首页、排行榜、领队页、线路详情）。
 *
 * 用户要求数据更新全部走 WebSocket、不轮询。但像「排行榜上某位领队的约单数变了」这种事，不值得每次都推给所有在线的人，
 * 所以页面打开时客户端发 { op: 'watch', topic: 'trip', on: true }，离开时发 on: false，服务器只推给登记着的人。
 * 按连接记：连接断了自动取消；断线重连后客户端会收到 ws_reopen，重新登记并补拉一次。
 * 只在本机内存里（现在只有一个后端节点）。以后跑多个节点：各节点只知道连在自己身上的人，推送时各推各的，要把推送也广播到别的节点。
 */
@Injectable()
export class WatchRegistry {
  private readonly bySocket = new WeakMap<WebSocket, Set<string>>();
  /** topic -> userId -> 这个人有几条连接登记着 */
  private readonly topics = new Map<string, Map<string, number>>();

  static readonly TOPICS = new Set(['trip']);

  set(ws: WebSocket, userId: bigint, topic: string, on: boolean) {
    if (!WatchRegistry.TOPICS.has(topic)) return;
    const mine = this.bySocket.get(ws) ?? new Set<string>();
    if (on === mine.has(topic)) return;
    const users = this.topics.get(topic) ?? new Map<string, number>();
    const key = userId.toString();
    if (on) {
      mine.add(topic);
      users.set(key, (users.get(key) ?? 0) + 1);
    } else {
      mine.delete(topic);
      const n = (users.get(key) ?? 1) - 1;
      if (n > 0) users.set(key, n); else users.delete(key);
    }
    this.bySocket.set(ws, mine);
    this.topics.set(topic, users);
  }

  /** 连接断了：这条连接登记过的都取消 */
  drop(ws: WebSocket, userId: bigint) {
    for (const topic of [...(this.bySocket.get(ws) ?? [])]) this.set(ws, userId, topic, false);
  }

  /** 正停在这一类页面上的人 */
  watchers(topic: string): string[] {
    return [...(this.topics.get(topic)?.keys() ?? [])];
  }
}
