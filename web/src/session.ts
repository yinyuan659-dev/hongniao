import { api, getDeviceId, getToken, setDid, setToken, UserProfile } from './api';
import { hnNative } from './bridge';
import { useApp } from './store';
import { wsManager } from './ws';

/** 通过刷脸新挂到这个账号上的一台设备（给其它设备的提醒里用） */
export interface NewDevice {
  id: string;
  /** android | ios | web */
  kind: string;
  /** 网页的浏览器名 */
  label: string;
  at: string;
}

interface EnterResp {
  registered: boolean;
  token: string | null;
  did?: string;
  user: UserProfile | null;
  newDevices?: NewDevice[];
}

/** 设备列表、提醒里怎么称呼一台设备 */
export function deviceName(d: { kind: string; label: string }): string {
  return d.kind === 'android' ? '安卓手机' : d.kind === 'ios' ? 'iPhone' : `网页${d.label ? `（${d.label}）` : ''}`;
}

const hosts = new Set<(d: NewDevice) => void>();

/** 订阅「账号在新设备登录了」（DeviceHost 用） */
export function onNewDevice(h: (d: NewDevice) => void): () => void {
  hosts.add(h);
  return () => void hosts.delete(h);
}

export function announceDevice(d: NewDevice) {
  hosts.forEach((h) => h(d));
}

/**
 * 换成一个新的登录身份（进入 / 刷脸找回 / 并号之后）：存令牌和设备编号、换当前用户、聊天连接用新令牌重连。
 * 在 App 的内嵌网页里还要告诉原生（原生的登录身份要跟着换），返回 true 表示原生接手了。
 */
export function adoptSession(token: string, did: string | undefined, user: UserProfile | null, tellNative = false): boolean {
  const prevUserId = getToken() ? useApp.getState().user?.id : undefined;
  setToken(token);
  setDid(did);
  useApp.getState().setUser(user);
  // 换了账号（找回、并号）才重连聊天连接；同一个账号只是换了个新令牌时不动它（旧令牌的连接照样有效）
  if (prevUserId && user && String(prevUserId) !== String(user.id)) wsManager.reconnect();
  return tellNative ? hnNative('session', { token, did: did ?? '' }) : false;
}

/** 用网页自己的设备号「进入」：这台设备挂在哪个账号下就登录哪个。顺便处理「不在的时候有新设备登录了」 */
export async function enterSession(): Promise<EnterResp> {
  const r = await api<EnterResp>('/auth/enter', { method: 'POST', body: { deviceId: getDeviceId() } });
  if (r.registered && r.token) {
    adoptSession(r.token, r.did, r.user);
    const d = r.newDevices?.[0];
    if (d) setTimeout(() => announceDevice(d), 800);
  }
  return r;
}
