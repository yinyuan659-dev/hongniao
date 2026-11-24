import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, isEmbedSession, loginDeviceId, reasonOf, UserProfile } from '../api';
import { hnNative, inNativeApp } from '../bridge';
import { adoptSession, enterSession } from '../session';
import { useApp } from '../store';
import { Ic, Nav } from '../hn';

/** 发起刷脸前记在本机的「这次认证」：刷完从刷脸页跳回来时靠它知道查哪一次、是认证还是找回、查完回哪 */
const PENDING_KEY = 'hn_kyc_pending';
/** 并号进了原来的账号后，「我的」页顶上提示一次 */
export const FLASH_KEY = 'hn_flash';

type Mode = 'kyc' | 'recover';

export function saveKycPending(certifyId: string, next: string, mode: Mode = 'kyc') {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ c: certifyId, next, mode, at: Date.now() })); } catch { /* 存不了也能靠网址里的编号查 */ }
}

function loadKycPending(): { c: string; next: string; mode: Mode } | null {
  try {
    const o = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    // 一次刷脸 30 分钟内有效，过期的不认
    if (o && typeof o.c === 'string' && Date.now() - Number(o.at) < 40 * 60_000) {
      return { c: o.c, next: typeof o.next === 'string' ? o.next : '/me', mode: o.mode === 'recover' ? 'recover' : 'kyc' };
    }
  } catch { /* 没有就算了 */ }
  return null;
}

function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* 不影响结果 */ }
}

/** 并号确认框里的内容：这张身份证之前认证过的那个账号 */
interface MergeInfo {
  nickname: string;
  avatar: string;
  shortId: string | null;
  createdAt: string;
  myNickname: string;
  myBalanceYuan: string;
}

/** 找回 / 并号成功后服务器给的新登录身份 */
interface Session {
  token: string;
  did: string;
  user: UserProfile;
  charged: boolean;
  feeYuan: string;
  balanceYuan: string;
  movedYuan?: string;
}

type State =
  | { k: 'checking' }
  | { k: 'ok' }
  | { k: 'fail'; reason: string }
  | { k: 'unfinished' }
  | { k: 'error'; msg: string; reason: string }
  | { k: 'merge'; info: MergeInfo; busy: boolean }
  | { k: 'recovered'; s: Session };

const day = (iso: string) => (iso ? new Date(iso).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-') : '');

/**
 * 刷完脸跳回来的结果页：/kyc-result?c=认证编号。真人认证和「刷脸找回」共用（发起时记了是哪一种）。
 * 到这里先问服务器最终结果（服务器再去问认证服务商），不信网址里带的结果。
 *   真人认证：通过 →「认证通过」→ 回到发起时的页面；没通过 → 红色「认证未通过」+ 原因 + 重新认证。
 *     这张身份证已经有一个认证过的账号（并号）→ 弹确认框，点了才进原来的账号。
 *   刷脸找回：通过 →「找回成功」+ 账号是谁 → 进入；没通过 → 不登录、不显示账号信息。
 * 样稿：design/04-kyc.html、design/05-recover.html。
 */
export function KycResultPage() {
  const nav = useNavigate();
  const sp = useSearchParams()[0];
  const pending = useRef(loadKycPending()).current;
  const certifyId = pending?.c || sp.get('c') || '';
  const mode: Mode = pending?.mode ?? 'kyc';
  const next = pending?.next || '/me';
  const setUser = useApp((s) => s.setUser);
  const [st, setSt] = useState<State>({ k: 'checking' });
  const asked = useRef(false);

  const check = async () => {
    if (!certifyId) return setSt({ k: 'unfinished' });
    setSt({ k: 'checking' });
    try {
      if (mode === 'recover') {
        const r = await api<{ passed: boolean; unfinished?: boolean; reason?: string } & Partial<Session>>(
          '/recover/finish', { method: 'POST', body: { deviceId: loginDeviceId(), certifyId } },
        );
        if (r.passed && r.token && r.user) {
          clearPending();
          // 先把登录身份换过来（这一页被刷新也还是登录着的），点「进入」再走
          adoptSession(r.token, r.did, r.user);
          setSt({ k: 'recovered', s: r as Session });
        } else if (r.unfinished) setSt({ k: 'unfinished' });
        else setSt({ k: 'fail', reason: r.reason || '刷脸没通过' });
        return;
      }
      const r = await api<{ passed: boolean; unfinished?: boolean; reason?: string; merge?: MergeInfo }>('/kyc/finish', { method: 'POST', body: { certifyId } });
      if (r.passed && r.merge) setSt({ k: 'merge', info: r.merge, busy: false });
      else if (r.passed) {
        clearPending();
        try { setUser(await api<UserProfile>('/user/me')); } catch { /* 状态刷新失败不影响结果 */ }
        setSt({ k: 'ok' });
        // 在 App 里：告诉原生认证通过了，原生刷新自己的状态、稍后关掉这个网页；在浏览器里：回到发起时的页面
        if (!hnNative('kycDone')) setTimeout(() => nav(next, { replace: true }), 1500);
      } else if (r.unfinished) setSt({ k: 'unfinished' });
      else setSt({ k: 'fail', reason: r.reason || '认证未通过' });
    } catch (e) {
      setSt({ k: 'error', msg: (e as Error).message, reason: reasonOf(e) });
    }
  };

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    check();
  }, []);

  const again = () => nav(mode === 'recover' ? '/recover' : `/kyc?next=${encodeURIComponent(next)}`, { replace: true });
  const later = () => {
    if (mode === 'recover') nav('/register', { replace: true });
    else nav(next, { replace: true });
  };

  /** 找回成功后点「进入」：在 App 里交给原生（原生换登录身份、关掉网页），在浏览器里进广场 */
  const enterApp = (s: Session) => {
    if (hnNative('session', { token: s.token, did: s.did })) return;
    nav('/plaza', { replace: true });
  };

  /** 并号确认框点「进入原来的账号」 */
  const confirmMerge = async (info: MergeInfo, retried = false): Promise<void> => {
    setSt({ k: 'merge', info, busy: true });
    try {
      const s = await api<Session>('/kyc/merge/confirm', { method: 'POST', body: { certifyId } });
      clearPending();
      const moved = Number(s.movedYuan) > 0 ? `新号里的 ¥${s.movedYuan} 已转入 AI 余额。` : '';
      try { sessionStorage.setItem(FLASH_KEY, `已回到你原来的账号「${s.user.nickname}」。${moved}`); } catch { /* 提示出不来不影响 */ }
      if (adoptSession(s.token, s.did, s.user, true)) return;
      nav('/me', { replace: true });
    } catch (e) {
      // 登录令牌是老的、里面没有设备信息：在浏览器里重新进入一次拿新令牌，再试一遍
      if (reasonOf(e) === 'need_relogin' && !retried && !isEmbedSession() && !inNativeApp()) {
        try { await enterSession(); } catch { /* 下面会再报一次错 */ }
        return confirmMerge(info, true);
      }
      setSt({ k: 'error', msg: (e as Error).message, reason: reasonOf(e) });
    }
  };

  let body: ReactNode;
  if (st.k === 'checking') {
    body = <div className="hn-t2" style={{ textAlign: 'center', padding: 70 }}>正在核对{mode === 'recover' ? '刷脸' : '认证'}结果…</div>;
  } else if (st.k === 'ok' || st.k === 'merge') {
    body = (
      <div style={{ textAlign: 'center', padding: '50px 30px 0' }}>
        <div style={{ ...ring, ...green }}><Ic n="check" s={46} /></div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 22 }}>{st.k === 'merge' ? '刷脸通过' : '认证通过'}</div>
        {st.k === 'ok' && <div className="hn-t2" style={{ marginTop: 8 }}>你的基础画像已经完成</div>}
      </div>
    );
  } else if (st.k === 'recovered') {
    const s = st.s;
    body = (
      <div style={{ padding: '30px 18px 0' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ ...ring, ...green }}><Ic n="check" s={46} /></div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 20 }}>找回成功</div>
          <div className="hn-t2" style={{ marginTop: 8 }}>这台设备已经登录你的账号</div>
        </div>
        <div className="hn-glass" style={{ marginTop: 20 }}><Account nickname={s.user.nickname} avatar={s.user.avatar} shortId={s.user.shortId ?? null} createdAt={s.user.createdAt ?? ''} /></div>
        <div className="hn-glass" style={{ marginTop: 12, padding: '2px 14px 12px', borderRadius: 20 }}>
          <Feat ic="chat" text="聊天记录、画像、喜欢的人、余额都在" />
          <Feat ic="users" text="原来的设备不受影响，可在「登录设备」里移除" />
          <Feat ic="wallet" text={s.charged ? `刷脸 ¥${s.feeYuan} 已从 AI 余额扣，剩 ¥${s.balanceYuan}` : '这次刷脸没有扣你的余额'} />
        </div>
        <button className="hn-btn" style={{ marginTop: 26 }} onClick={() => enterApp(s)}>进入</button>
      </div>
    );
  } else if (st.k === 'fail') {
    body = (
      <div style={{ textAlign: 'center', padding: '50px 30px 0' }}>
        <div style={{ ...ring, ...red }}><Ic n="x" s={46} /></div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 22, color: '#e5484d' }}>{mode === 'recover' ? '刷脸没通过' : '认证未通过'}</div>
        <div className="hn-t2" style={{ marginTop: 10, lineHeight: 1.7 }}>{mode === 'recover' ? <>不能确认是你本人，没有登录。<br />{st.reason}</> : st.reason}</div>
        {mode === 'kyc' && <div className="hn-t3" style={{ marginTop: 10 }}>这次没有扣费</div>}
        <div style={{ marginTop: 30 }}>
          <button className="hn-btn" onClick={again}><Ic n="refresh" s={17} />{mode === 'recover' ? '重新刷脸' : '重新认证'}</button>
          <button className="hn-btn flat" style={{ marginTop: 12 }} onClick={later}>{mode === 'recover' ? '返回' : '以后再说'}</button>
        </div>
      </div>
    );
  } else if (st.k === 'unfinished') {
    body = (
      <div style={{ textAlign: 'center', padding: '50px 30px 0' }}>
        <div style={{ ...ring, ...orange }}><Ic n="info" s={46} /></div>
        <div style={{ fontSize: 22, fontWeight: 800, marginTop: 22 }}>刷脸没有完成</div>
        <div className="hn-t2" style={{ marginTop: 10, lineHeight: 1.7 }}>可能是中途退出了，或者摄像头没有打开。<br />没有扣费，可以重新来一次。</div>
        <div style={{ marginTop: 30 }}>
          <button className="hn-btn" onClick={again}><Ic n="refresh" s={17} />{mode === 'recover' ? '重新刷脸' : '重新认证'}</button>
          {certifyId && <button className="hn-btn flat" style={{ marginTop: 12 }} onClick={check}>我已经刷完了，再查一次</button>}
          <button className="hn-btn flat" style={{ marginTop: 12 }} onClick={later}>{mode === 'recover' ? '返回' : '以后再说'}</button>
        </div>
      </div>
    );
  } else {
    // 查结果时出错：余额不够、这个身份证已被别的账号用了、网络问题等
    body = (
      <div style={{ textAlign: 'center', padding: '50px 30px 0' }}>
        <div style={{ ...ring, ...red }}><Ic n="info" s={46} /></div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 22 }}>{mode === 'recover' ? '没能找回' : '没能完成认证'}</div>
        <div className="hn-t2" style={{ marginTop: 10, lineHeight: 1.7 }}>{st.msg}</div>
        <div style={{ marginTop: 30 }}>
          {st.reason === 'no_balance'
            ? <button className="hn-btn" onClick={() => nav('/ai-fee/topup')}>去充值</button>
            : st.reason === 'id_used_other'
              ? null
              : <button className="hn-btn" onClick={check}><Ic n="refresh" s={17} />再查一次</button>}
          <button className="hn-btn flat" style={{ marginTop: 12 }} onClick={later}>返回</button>
        </div>
      </div>
    );
  }

  return (
    <div className="hn-page">
      <Nav title={mode === 'recover' ? '找回账号' : '实人认证'} onBack={later} />
      <div className="hn-scroll" style={{ paddingBottom: 24 }}>{body}</div>

      {/* 并号：这张身份证之前认证过另一个账号。刷脸通过了才显示它是谁，点了确认才进去 */}
      {st.k === 'merge' && (
        <div className="hn-dim">
          <div className="hn-sheet" style={{ paddingTop: 24 }}>
            <div style={{ fontSize: 19, fontWeight: 800, textAlign: 'center' }}>你已经有一个账号了</div>
            <div className="hn-t2" style={{ textAlign: 'center', marginTop: 8, lineHeight: 1.6 }}>这张身份证之前认证过下面这个账号。<br />一个人只能有一个账号。</div>
            <div style={{ background: '#faf5f6', borderRadius: 20, marginTop: 14 }}>
              <Account nickname={st.info.nickname} avatar={st.info.avatar} shortId={st.info.shortId} createdAt={st.info.createdAt} />
            </div>
            <Feat ic="users" text="进入后，这台设备登录的就是上面这个账号" />
            <Feat ic="trash" text={`现在这个新号「${st.info.myNickname}」会作废，资料和聊天不保留`} />
            {Number(st.info.myBalanceYuan) > 0 && <Feat ic="wallet" text={`新号里的 AI 余额 ¥${st.info.myBalanceYuan} 会转到原来的账号`} />}
            <button className="hn-btn" style={{ marginTop: 18 }} disabled={st.busy} onClick={() => confirmMerge(st.info)}>{st.busy ? '处理中…' : '进入原来的账号'}</button>
            <button className="hn-btn flat" style={{ marginTop: 10 }} disabled={st.busy} onClick={() => { clearPending(); later(); }}>先不进，留在现在这个号</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 一个账号的小卡片：头像、昵称、真人认证标、短号和注册日期 */
function Account({ nickname, avatar, shortId, createdAt }: { nickname: string; avatar: string; shortId: string | null; createdAt: string }) {
  return (
    <div className="hn-row" style={{ gap: 12, padding: 14 }}>
      <div style={{ width: 56, height: 56, borderRadius: 28, flexShrink: 0, border: '2px solid #fff', boxShadow: '0 4px 10px rgba(43,28,34,.14)', background: avatar ? `center / cover no-repeat url(${avatar})` : '#eee' }} />
      <div style={{ minWidth: 0 }}>
        <div className="hn-row" style={{ gap: 6 }}>
          <b style={{ fontSize: 17, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nickname}</b>
          <span style={verify}><Ic n="shield" s={12} />真人认证</span>
        </div>
        <div className="hn-t3" style={{ marginTop: 5 }}>{shortId ? `短号 ${shortId} · ` : ''}{day(createdAt)} 注册</div>
      </div>
    </div>
  );
}

function Feat({ ic, text }: { ic: string; text: string }) {
  return (
    <div className="hn-row" style={{ gap: 12, marginTop: 12 }}>
      <span className="hn-sq" style={{ flexShrink: 0 }}><Ic n={ic} s={18} /></span>
      <span style={{ fontSize: 14, lineHeight: 1.5, textAlign: 'left' }}>{text}</span>
    </div>
  );
}

const ring: CSSProperties = { width: 92, height: 92, borderRadius: 46, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const green: CSSProperties = { background: '#e3f7ec', color: '#12b76a', boxShadow: '0 0 0 10px rgba(18,183,106,.08)' };
const red: CSSProperties = { background: '#fde8e8', color: '#e5484d', boxShadow: '0 0 0 10px rgba(229,72,77,.08)' };
const orange: CSSProperties = { background: '#fff1e0', color: '#f08c00', boxShadow: '0 0 0 10px rgba(240,140,0,.08)' };
const verify: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 8px', borderRadius: 11, flexShrink: 0,
  fontSize: 11, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#12b76a,#22c55e)', whiteSpace: 'nowrap',
};
