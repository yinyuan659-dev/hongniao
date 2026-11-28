import { CSSProperties } from 'react';
import { Ic } from './hn';

/**
 * 群聊在网页端共用的类型和小零件（样稿 design/12-group.html，用户 2026-11-27 过关）。
 * 规则都在后端（houduan/src/im/group.service.ts）：只有线路群和活动群，进群只能从「约单 / 参与」；只有群主和成员两种人。
 * 群的变化服务器都会推 { op: 'group', data: { event, groupId, conversationId, group, userId?, nickname? } }，页面拿 group 直接改，不轮询。
 */

/** 我和这个群的关系：ok 正常 | left 我退出了 | kicked 我被移出了 | dissolved 群解散了 | closed 群被平台关闭 */
export type GroupState = 'ok' | 'left' | 'kicked' | 'dissolved' | 'closed';

/** 群的公开信息：消息列表、推送里带的都是这一份（列表里另外带 state、role） */
export interface GroupLite {
  id: string;
  name: string;
  avatar: string;
  /** trip 旅行线路的群 | event 相亲活动的群 | test 后台建的测试群 */
  kind: string;
  refId?: string;
  ownerId: string;
  /** 0 正常 1 已解散 2 被平台关闭 */
  status: number;
  memberCount: number;
  memberLimit?: number;
  notice?: string;
  conversationId?: string | null;
  /** 活动开始 / 行程结束的时间；过了以后提示「N 天后自动解散」 */
  endAt?: string | null;
  expireAt?: string | null;
  state?: GroupState;
  role?: string;
}

export interface GroupMemberView { id: string; nickname: string; avatar: string; gender: number; role: string; joinedAt: string }

/** GET /im/group/:id */
export interface GroupView extends GroupLite {
  notice: string;
  state: GroupState;
  role: string;
  muted: boolean;
  /** 已经不在群里的人拿到的是空名单 */
  members: GroupMemberView[];
}

/** 推送来的 { op: 'group' } 帧里的 data */
export interface GroupEvent {
  /** create / join / leave / kick / info / dissolved / closed / reopen */
  event: string;
  groupId: string;
  conversationId: string | null;
  group: GroupLite;
  /** 进群 / 退群 / 被移出的是谁 */
  userId?: string;
  nickname?: string;
}

/** 群主在这种群里叫什么 */
export const ownerLabel = (kind: string) => (kind === 'trip' ? '领队' : kind === 'event' ? '发起人' : '群主');
/** 群名后面的小标签 */
export const kindLabel = (kind: string) => (kind === 'trip' ? '旅行' : kind === 'event' ? '活动' : '测试');

/** 群里中间那行灰色小字（消息类型 sys，内容是 {k, text}） */
export function sysText(content: string): string {
  try {
    return String(JSON.parse(content).text ?? '');
  } catch {
    return '';
  }
}

/** 群用不了时，输入框换成的那句话 */
export const GROUP_END_TEXT: Record<Exclude<GroupState, 'ok'>, string> = {
  left: '你已不在这个群里',
  kicked: '你已不在这个群里',
  dissolved: '这个群已解散',
  closed: '这个群因违规已被平台关闭',
};

/** 服务器拒绝时带的原因 → 群的状态（error 帧的 code、接口报错的 reason） */
export const GROUP_REASON_STATE: Record<string, Exclude<GroupState, 'ok'>> = {
  group_left: 'left',
  group_dissolved: 'dissolved',
  group_closed: 'closed',
};

/** 推送里的群信息 + 这件事说的是不是我 → 我现在的状态（推送里的 group 不带 state，要自己算） */
export function stateAfter(ev: GroupEvent, myId: string | undefined, prev: GroupState | undefined): GroupState {
  if (ev.userId && ev.userId === myId) {
    if (ev.event === 'leave') return 'left';
    if (ev.event === 'kick') return 'kicked';
    if (ev.event === 'join') return ev.group.status === 1 ? 'dissolved' : ev.group.status === 2 ? 'closed' : 'ok';
  }
  if (prev === 'left' || prev === 'kicked') return prev;
  return ev.group.status === 1 ? 'dissolved' : ev.group.status === 2 ? 'closed' : 'ok';
}

/** 活动 / 行程已经结束、群还没解散的那几天，输入框上面的提示。不用提示时返回 null */
export function expireTip(g: { kind: string; endAt?: string | null; expireAt?: string | null }, now = Date.now()): string | null {
  if (!g.endAt || !g.expireAt) return null;
  const end = new Date(g.endAt).getTime();
  const left = new Date(g.expireAt).getTime() - now;
  if (Number.isNaN(end) || Number.isNaN(left) || end > now || left <= 0) return null;
  const head = g.kind === 'trip' ? '行程已结束' : g.kind === 'event' ? '活动已结束' : '已到结束时间';
  const when = left >= 86400_000 ? ` ${Math.ceil(left / 86400_000)} 天后` : left >= 3600_000 ? ` ${Math.ceil(left / 3600_000)} 小时后` : '不到 1 小时后';
  return `${head}，这个群${when}自动解散`;
}

const AVATAR_BG: Record<string, string> = {
  trip: 'linear-gradient(160deg, #3d6b8f 0%, #7fa7b8 38%, #d9c7a3 70%, #8a6a4a 100%)',
  event: 'linear-gradient(165deg, #2f5d50 0%, #6fa07a 55%, #cfe3b4 100%)',
  test: 'linear-gradient(160deg, #6b6f8f 0%, #a9adc8 100%)',
};

/** 群头像：方的圆角（人是圆的，一眼分得出）。有封面用封面，没有按类型画一个默认的 */
export function GroupAvatar({ g, size = 54, style }: { g: { avatar?: string; kind: string }; size?: number; style?: CSSProperties }) {
  const r = Math.round(size * 0.3);
  return (
    <div style={{ width: size, height: size, borderRadius: r, flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: AVATAR_BG[g.kind] ?? AVATAR_BG.test, ...style }}>
      {g.avatar
        ? <img src={g.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <Ic n={g.kind === 'trip' ? 'car' : g.kind === 'event' ? 'leaf' : 'users'} s={Math.round(size * 0.44)} />}
    </div>
  );
}

/** 群名后面的「旅行 / 活动」小标签 */
export function KindTag({ kind }: { kind: string }) {
  const c = kind === 'trip' ? { background: '#e6f0f7', color: '#2f6690' } : kind === 'event' ? { background: '#e5f4e8', color: '#2f7d4a' } : { background: '#eeeef3', color: '#6b6f8f' };
  return <span style={{ fontSize: 10.5, height: 18, padding: '0 7px', borderRadius: 9, display: 'inline-flex', alignItems: 'center', fontWeight: 600, flexShrink: 0, ...c }}>{kindLabel(kind)}</span>;
}

/** 昵称后面的红色小标：领队 / 发起人 */
export function OwnerBadge({ kind, style }: { kind: string; style?: CSSProperties }) {
  return <span style={{ fontSize: 10, color: '#fff', background: 'var(--hn-rose, #ff3d63)', borderRadius: 7, padding: '0 5px', marginLeft: 5, fontWeight: 700, lineHeight: '15px', display: 'inline-block', whiteSpace: 'nowrap', ...style }}>{ownerLabel(kind)}</span>;
}
