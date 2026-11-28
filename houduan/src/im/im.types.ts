/**
 * IM WebSocket JSON 协议
 *
 * 客户端 -> 服务端：
 *   { op: "send", tempId, convType: 1|2, targetId, msgType, content }
 *     convType 1=单聊(targetId=对方用户id) 2=群聊(targetId=群id)
 *     msgType: text|image|video|audio|file|location
 *     file 的 content 为 {url,name,size,mime}，url 来自 POST /upload/file（见 im.service sanitizeFile）
 *   { op: "read", conversationId, msgId }
 *   { op: "ping" }
 *   { op: "watch", topic: "trip", on: true|false }
 *       正停在某一类页面上（旅行首页、排行榜、领队页、线路详情）：登记 / 取消。服务器只把那一类的变化推给登记着的人（见 watch.registry.ts）。
 *       连接断了自动取消，重连后要重新发。
 *
 * 服务端 -> 客户端：
 *   { op: "msg", data: MessagePayload }
 *   { op: "ack", tempId, msgId, conversationId, createdAt }
 *   { op: "read", conversationId, msgId, userId }
 *   { op: "error", tempId?, msg }
 *   { op: "pong" }
 *   { op: "msg_delete", data: { conversationId, msgId } }                  用户删除（为双方删除 / 自己其他设备上的「只删自己」）
 *   { op: "msg_reactions", data: { conversationId, msgId, reactions } }    表情回应变了（不发给操作人，操作人以接口返回为准）
 *   { op: "msg_pin", data: { conversationId, msgId, pinned } }             置顶 / 取消置顶
 *   { op: "group", data: { event, groupId, conversationId, group, userId?, nickname? } }
 *       群有变化（见 group.service.ts）：event = create / join / leave / kick / info / dissolved / closed / reopen；
 *       group 是最新的群信息（名字、公告、人数、status…），userId 是这件事说的是谁（进群 / 退群 / 被移出的人）。
 *       客户端拿它直接改页面，不用再去问服务器。
 *   { op: "conv_refresh" }                                                 消息列表有变化，重新拉一次列表
 *   { op: "trip", data: { event, tripId?, leaderId?, pass?, on? } }
 *       领队旅行有变化（见 trip.service.ts）：event = trip（某条线路变了）| rank（排行榜变了）——只推给发过 watch 的人；
 *       review（审核结果，给领队）| leader（被设为 / 取消领队，给本人）。客户端收到后重新取那一页。
 *
 * 群聊：msg 帧里 convType=2，带 groupId、groupName；type=sys 是群里中间那行灰色小字，content 是 {k, text}。
 * 群用不了时 error 帧带 code：group_left（我不在群里了）/ group_dissolved / group_closed。
 *
 * send 帧可带 replyToId（回复同会话里的某条消息）。
 */

export interface SendFrame {
  op: 'send';
  tempId?: string;
  convType: 1 | 2;
  targetId: string;
  msgType: string;
  content: string;
  replyToId?: string;
  /** 只在服务端转发时设置，客户端帧里的会被网关丢掉 */
  fwdFrom?: string;
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderNickname: string;
  type: string;
  /** 文字取前 100 字、图片是 url，其余类型为空 */
  content: string;
  /** 原消息已被删除 */
  deleted?: boolean;
}

export interface ReactionView {
  emoji: string;
  count: number;
  /** 点了这个表情的人（最多 20 个），客户端据此判断「我点过」 */
  userIds: string[];
}

export interface ReadFrame {
  op: 'read';
  conversationId: string;
  msgId: string;
}

export interface MessagePayload {
  id: string;
  conversationId: string;
  convType: number;
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
  reactions?: ReactionView[];
}

/** Redis 跨节点投递载荷 */
export interface RouteEnvelope {
  userIds: string[];
  frame: unknown;
}
