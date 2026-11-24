import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getDid, getToken, isEmbedSession, reasonOf, setToken } from '../api';
import { inNativeApp } from '../bridge';
import { deviceName, enterSession, NewDevice, onNewDevice } from '../session';
import { useApp } from '../store';
import { wsManager } from '../ws';
import { Ic, Nav, Orb, useBack, useToast } from '../hn';

interface Device {
  id: string;
  kind: string;
  label: string;
  /** register 注册 | recover 刷脸找回 | merge 并号带过来 */
  via: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 今天 15:01 / 昨天 09:30 / 11-23 */
function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400_000);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days <= 0) return `今天 ${hm}`;
  if (days === 1) return `昨天 ${hm}`;
  return `${d.getFullYear() === now.getFullYear() ? '' : `${d.getFullYear()}-`}${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 刚刚在用 / 2 小时前用过 / 3 天前用过 */
function seen(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 10) return '刚刚在用';
  if (min < 60) return `${min} 分钟前用过`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时前用过`;
  if (min < 2880) return '昨天用过';
  return `${Math.floor(min / 1440)} 天前用过`;
}

const VIA: Record<string, string> = { register: '注册时的设备', recover: '刷脸找回加入', merge: '并号时加入' };

/**
 * 登录设备（/devices，「我的」→ 账号与安全 → 登录设备）。样稿 design/05-recover.html 第 4 组。
 * 列出能登录这个账号的所有设备，不认识的、不用了的可以移除（移除后那台设备马上退出，想再用要重新刷脸找回）。
 * 新设备要登录这个账号必须本人刷脸，所以没做过真人认证的账号这里只有本机一台。
 */
export function DevicesPage() {
  const nav = useNavigate();
  const back = useBack();
  const [data, setData] = useState<{ devices: Device[]; max: number; realname: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [toast, showToast] = useToast();

  const load = () => api<{ devices: Device[]; max: number; realname: boolean }>('/devices').then(setData).catch((e) => showToast((e as Error).message));
  useEffect(() => { load(); }, []);

  const remove = async (d: Device, retried = false): Promise<void> => {
    if (busy) return;
    if (!retried && !window.confirm(`移除这台${deviceName(d)}？\n移除后它会马上退出登录，想再用要重新刷脸找回。`)) return;
    setBusy(d.id);
    try {
      await api(`/devices/${d.id}`, { method: 'DELETE' });
      showToast('已移除');
      await load();
    } catch (e) {
      // 登录令牌是老的、里面没有设备信息，服务器分不清哪台是本机：在浏览器里重新进入一次拿新令牌，再试一遍
      if (reasonOf(e) === 'need_relogin' && !retried && !isEmbedSession() && !inNativeApp()) {
        try { await enterSession(); } catch { /* 下面会再报一次 */ }
        setBusy('');
        return remove(d, true);
      }
      showToast((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="hn-page">
      <Nav title="登录设备" onBack={back} />
      <div className="hn-scroll" style={{ padding: '6px 16px 24px' }}>
        <div className="hn-t2" style={{ padding: '0 6px 10px', lineHeight: 1.6 }}>下面这些设备可以直接登录你的账号。不认识的、不用了的，移除掉。</div>
        {!data ? <div className="hn-t2" style={{ textAlign: 'center', padding: 50 }}>加载中…</div> : (
          <>
            <div className="hn-glass" style={{ borderRadius: 20, overflow: 'hidden' }}>
              {data.devices.map((d, i) => (
                <div key={d.id} className="hn-row" style={{ gap: 12, padding: '13px 14px', borderTop: i ? '1px solid var(--hn-line)' : undefined }}>
                  <span className="hn-sq" style={{ width: 40, height: 40, borderRadius: 13 }}><Ic n={d.kind === 'web' ? 'link' : 'home'} s={19} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{deviceName(d)}</div>
                    <div className="hn-t3" style={{ marginTop: 3, lineHeight: 1.5 }}>{when(d.createdAt)} {VIA[d.via] ?? '加入'} · {seen(d.lastSeenAt)}</div>
                  </div>
                  {d.current
                    ? <span style={{ fontSize: 12, color: '#12b76a', fontWeight: 700, whiteSpace: 'nowrap' }}>本机</span>
                    : <button className="hn-pill ghost" style={{ height: 30, background: '#f5f0f1', boxShadow: 'none' }} disabled={!!busy} onClick={() => remove(d)}>{busy === d.id ? '…' : '移除'}</button>}
                </div>
              ))}
            </div>

            {data.realname ? (
              <>
                <div className="hn-glass" style={{ ...tip, marginTop: 14 }}><Ic n="shield" s={15} style={tipIc} /><span>新设备要登录你的账号，必须你本人刷脸。别人知道你的身份证号也登不上。</span></div>
                <div className="hn-glass" style={{ ...tip, marginTop: 10 }}><Ic n="info" s={15} style={tipIc} /><span>移除后，那台设备会马上退出；想再用，要重新刷脸找回。一个账号最多同时挂 {data.max} 台设备。</span></div>
              </>
            ) : (
              <div className="hn-glass" style={{ borderRadius: 16, padding: '12px 14px', marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="hn-sq"><Ic n="shield" s={18} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5 }}>完成真人认证</div>
                  <div className="hn-t3" style={{ marginTop: 2, lineHeight: 1.5 }}>认证过的账号，换手机也能刷脸找回</div>
                </div>
                <button className="hn-pill" onClick={() => nav('/kyc?next=/devices')}>去认证 <Ic n="right" s={14} /></button>
              </div>
            )}
          </>
        )}
      </div>
      {toast}
    </div>
  );
}

const tip = { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 16, fontSize: 12.5, lineHeight: 1.6, color: 'var(--hn-ink2)' } as const;
const tipIc = { color: 'var(--hn-rose)', marginTop: 2, flexShrink: 0 } as const;

/**
 * 放在 App 最外层：
 *   - 这个账号在一台新设备上通过刷脸登录了 → 其它设备各弹一次「你的账号在新设备登录了」；
 *   - 本机被别的设备移除了 → 马上退出，回到注册页。
 * 在线时靠服务器推送（op: device），不在线的下次进入时由 enterSession 补弹。App 里由原生负责，网页不重复弹。
 */
export function DeviceHost() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [d, setD] = useState<NewDevice | null>(null);

  useEffect(() => onNewDevice((nd) => setD((cur) => cur ?? nd)), []);

  useEffect(() => {
    if (!me?.id || !getToken() || inNativeApp()) return;
    wsManager.connect();
    return wsManager.on((f) => {
      if (f.op !== 'device' || !f.data) return;
      const mine = getDid();
      if (f.event === 'added' && f.data.id !== mine) setD((cur) => cur ?? (f.data as NewDevice));
      // 本机被移除：退出登录，回到注册页（那里可以重新刷脸找回）
      if (f.event === 'removed' && mine && f.data.id === mine) {
        wsManager.close();
        setToken(null);
        useApp.getState().setUser(null);
        window.alert('这台设备已被移除，已退出登录。');
        nav('/register', { replace: true });
      }
    });
  }, [me?.id]);

  if (!d) return null;
  return (
    <div className="hn-dim" onClick={() => setD(null)}>
      <div className="hn-sheet" style={{ paddingTop: 26 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'center' }}><Orb size="lg" /></div>
        <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 800, marginTop: 16 }}>你的账号在新设备登录了</div>
        <div className="hn-t2" style={{ textAlign: 'center', marginTop: 8, lineHeight: 1.7 }}>{when(d.at)}，一台<b style={{ color: 'var(--hn-ink)' }}>{deviceName(d)}</b>通过刷脸登录了你的账号。</div>
        <div className="hn-row" style={{ gap: 12, marginTop: 14 }}><span className="hn-sq"><Ic n="check" s={18} /></span><span style={{ fontSize: 14 }}>是你本人换了手机：不用管，两台都能用</span></div>
        <div className="hn-row" style={{ gap: 12, marginTop: 12 }}><span className="hn-sq"><Ic n="shield" s={18} /></span><span style={{ fontSize: 14 }}>不是你：马上移除那台设备</span></div>
        <button className="hn-btn" style={{ marginTop: 18 }} onClick={() => setD(null)}>是我本人</button>
        <button className="hn-btn flat" style={{ marginTop: 10 }} onClick={() => { setD(null); nav('/devices'); }}>不是我，去移除</button>
      </div>
    </div>
  );
}
