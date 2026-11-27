import { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, useCallback, useEffect, useState } from 'react';
import { NavigateFunction, useNavigate } from 'react-router-dom';
import { api, getToken, reasonOf } from './api';
import { hnNative, inNativeApp, openNativeChat } from './bridge';
import { Ic, useToast } from './hn';
import { useApp } from './store';
import { wsManager } from './ws';

/**
 * 每日推荐、喜欢 / 跳过、互相喜欢 —— 几个页面共用的类型和零件：
 * 点喜欢（useLike）、互相喜欢的庆祝页（MatchHost）、小号的喜欢按钮（LikePill）。
 * 样稿：design/03-match.html
 */

/** none 都没表态 | liked 我喜欢了、对方还没回应 | likedMe 对方先喜欢了我 | mutual 互相喜欢 | ended 有一方结束了联系 */
export type RelState = 'none' | 'liked' | 'likedMe' | 'mutual' | 'ended';

/** 在遇见 / 别人的画像里自己点喜欢的名额（每日推荐里的、回应对方喜欢的不占） */
export interface Quota { limit: number; used: number; left: number }

export interface Relation {
  state: RelState;
  /** 我以前点过跳过 / 不合适 */
  passed: boolean;
  endedBy: 'me' | 'peer' | null;
  matchedAt: string | null;
  /** 现在能不能给对方发消息、打语音：2026-11-27 起只有一方点了「不再联系」才不能 */
  canChat: boolean;
  /** open 还没互相喜欢，照常能聊 | mutual 互相喜欢 | ended_me | ended_peer */
  chatReason: string;
  /** 按「互相喜欢」这一条现在能不能视频见面（后台开关关着时没互相喜欢也是 true）；网页端没有通话，这两个字段只有 App 用 */
  canVideo?: boolean;
  /** ok | need_like | ended */
  videoReason?: string;
  /** 以前「老聊天保留期」用的，现在一直是 null */
  legacyUntil: string | null;
  quota: Quota;
  /** 我的基本情况填完了没有（没填完不能点喜欢） */
  ready: boolean;
}

/** 画像网页接口里的 match：关系 + 共同点 + 为什么推荐给我 */
export interface CardMatch extends Relation {
  recommended: boolean;
  tags: string[];
  reason: string;
}

export interface PeerLite { id: string; nickname: string; avatar: string; gender?: number; age?: number; cityName?: string }

export interface LikeResult {
  state: RelState;
  matched: boolean;
  peer: PeerLite;
  conversationId: string | null;
  quota: Quota;
}

export interface MatchSummary {
  likedMe: number;
  likedMeNew: number;
  liked: number;
  mutual: number;
  newMatches: { peer: PeerLite; conversationId: string }[];
  quota: Quota;
  ready: boolean;
}

/** 列表 / 推荐卡片上的一个人 */
export interface MatchPerson {
  user: PeerLite;
  /** 城市、身高、学历、职业 */
  chips: string[];
  tags: string[];
}

/** 打开和某个人的聊天（App 的内嵌网页里交给原生聊天页）。draft：先填进输入框的话 */
export async function openChatWith(nav: NavigateFunction, peer: { id: string; nickname: string }, draft = '') {
  const r = await api<{ conversationId: string }>(`/im/conversations/open/${peer.id}`, { method: 'POST' });
  if (openNativeChat(r.conversationId, 1, peer.id, peer.nickname)) return;
  nav(`/chatroom/${r.conversationId}`, { state: { title: peer.nickname, targetId: peer.id, draft } });
}

// ---------- 互相喜欢的庆祝页 ----------

type Matched = { peer: PeerLite; conversationId: string };
const hosts = new Set<(m: Matched) => void>();

/** 弹出庆祝页。App 的内嵌网页里交给原生弹（原生的能盖住整个 App，还能直接进原生聊天页） */
export function showMatch(m: Matched) {
  if (hnNative('matched', { id: m.peer.id, nickname: m.peer.nickname, avatar: m.peer.avatar, conversationId: m.conversationId })) return;
  hosts.forEach((h) => h(m));
}

/**
 * 放在 App 最外层，任何页面上都能弹出庆祝页：
 *   - 我点喜欢时对方早就喜欢我了 → 点的那一下当场弹（showMatch）；
 *   - 对方回了我的喜欢 → 服务器推一条消息过来，或者我下次打开时发现有没看过的，补弹。
 */
export function MatchHost() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [m, setM] = useState<Matched | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    hosts.add(setM);
    return () => void hosts.delete(setM);
  }, []);

  useEffect(() => {
    // App 里由原生负责弹，网页不重复弹
    if (!me?.id || !getToken() || inNativeApp()) return;
    const check = () => api<MatchSummary>('/match/summary').then((s) => { if (s.newMatches[0]) setM((cur) => cur ?? s.newMatches[0]); }).catch(() => {});
    check();
    wsManager.connect();
    return wsManager.on((f) => { if (f.op === 'match' && f.event === 'matched') check(); });
  }, [me?.id]);

  const peerId = m?.peer.id;
  useEffect(() => {
    if (!peerId) return;
    setLines([]);
    api(`/match/seen/${peerId}`, { method: 'POST' }).catch(() => {});
    // 开场白：有余额或 Key 才有，没有就不显示这一块
    api<{ lines: string[] }>(`/match/icebreakers/${peerId}`, { method: 'POST' }).then((r) => setLines(r.lines)).catch(() => {});
  }, [peerId]);

  if (!m) return null;
  const go = (draft = '') => {
    setM(null);
    nav(`/chatroom/${m.conversationId}`, { state: { title: m.peer.nickname, targetId: m.peer.id, draft } });
  };
  return (
    <div className="hn-match">
      <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 2 }}>互相喜欢了</div>
      <div style={{ fontSize: 14, opacity: 0.92, marginTop: 8 }}>你和{m.peer.nickname}都喜欢了对方，现在可以聊天了</div>
      <div className="hn-duo">
        <div className="a" style={me?.avatar ? { backgroundImage: `url(${me.avatar})` } : undefined} />
        <div className="h"><Ic n="heart" s={26} /></div>
        <div className="a" style={m.peer.avatar ? { backgroundImage: `url(${m.peer.avatar})` } : undefined} />
      </div>
      {lines.length > 0 && (
        <div className="hn-ice">
          <div className="hn-row" style={{ fontSize: 12.5, fontWeight: 600, gap: 6 }}>
            <Ic n="spark" s={13} />AI 红娘帮你想的开场白
            <span style={{ marginLeft: 'auto', opacity: 0.8, fontWeight: 400, fontSize: 11 }}>AI 生成 · 点一句带进聊天</span>
          </div>
          {lines.map((l) => <span key={l} onClick={() => go(l)}>{l}</span>)}
        </div>
      )}
      <button className="hn-btn" style={{ marginTop: 22, background: '#fff', color: 'var(--hn-rose)', boxShadow: '0 12px 26px rgba(120,10,40,.3)' }} onClick={() => go()}>开始聊天</button>
      <div style={{ marginTop: 14, fontSize: 14, opacity: 0.9, cursor: 'pointer', padding: 8 }} onClick={() => setM(null)}>待会儿再说</div>
    </div>
  );
}

// ---------- 点喜欢 ----------

/** 没填完基本情况的人点了「喜欢」 */
export function NeedProfileDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  return (
    <div className="hn-dim center" onClick={onClose}>
      <div className="hn-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>先把基本情况填完</div>
        <div className="hn-t2" style={{ marginTop: 6, lineHeight: 1.6 }}>填完才能喜欢别人，别人也才能在推荐里看到你。</div>
        <div className="hn-row" style={{ marginTop: 16 }}>
          <button className="hn-btn flat" style={{ flex: 1, height: 44, fontSize: 14.5 }} onClick={onClose}>以后再说</button>
          <button className="hn-btn" style={{ flex: 1.3, height: 44, fontSize: 15 }} onClick={() => { onClose(); if (!hnNative('interview', { edit: '' })) nav('/interview'); }}>去填写</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 点喜欢：like(对方 id) 成功返回结果（互相喜欢时已经顺手弹出庆祝页），失败返回 null（提示已经弹过了）。
 * node 要放进页面里（里面是提示条和「先把基本情况填完」的弹框）。
 */
export function useLike(): { like: (id: string) => Promise<LikeResult | null>; busy: boolean; node: ReactNode; toast: (msg: string) => void } {
  const [need, setNeed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toastNode, toast] = useToast();
  const like = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const r = await api<LikeResult>(`/match/like/${id}`, { method: 'POST' });
      if (r.matched && r.conversationId) showMatch({ peer: r.peer, conversationId: r.conversationId });
      return r;
    } catch (e) {
      if (reasonOf(e) === 'need_profile') setNeed(true);
      else toast((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { like, busy, toast, node: <>{toastNode}{need && <NeedProfileDialog onClose={() => setNeed(false)} />}</> };
}

/**
 * 小号的喜欢按钮：动态详情、老的主页这些原来放「发消息 / 打招呼」的地方用。
 * 没表态 →「喜欢」；我喜欢了 →「已喜欢」；对方先喜欢了我 →「也喜欢」；互相喜欢 →「发消息」。
 * withChat：旁边再放一个「发消息」（2026-11-27 起发消息不用互相喜欢；别人的主页底部用，列表里不用）。
 */
export function LikePill({ peer, initial, style, withChat }: { peer: { id: string; nickname: string }; initial?: RelState; style?: CSSProperties; withChat?: boolean }) {
  const nav = useNavigate();
  const [state, setState] = useState<RelState | undefined>(initial);
  const { like, busy, node, toast } = useLike();
  useEffect(() => {
    if (initial) return;
    api<Relation>(`/match/relation/${peer.id}`).then((r) => setState(r.state)).catch(() => {});
  }, [peer.id, initial]);

  if (!state || state === 'ended') return <>{node}</>;
  const chat = (e: ReactMouseEvent) => {
    e.stopPropagation();
    openChatWith(nav, peer).catch((err) => toast((err as Error).message));
  };
  const tap = async (e: ReactMouseEvent) => {
    if (state === 'mutual') return chat(e);
    e.stopPropagation();
    if (state === 'liked' || busy) return;
    const r = await like(peer.id);
    if (r) setState(r.state);
  };
  return (
    <>
      {withChat && state !== 'mutual' && (
        <button className="hn-pill ghost" style={{ ...style, color: 'var(--hn-rose)' }} onClick={chat}><Ic n="chat" s={14} />发消息</button>
      )}
      <button className={`hn-pill${state === 'liked' ? ' ghost' : ''}`} style={style} onClick={tap} disabled={busy}>
        {state === 'mutual' ? <><Ic n="chat" s={14} />发消息</> : state === 'liked' ? <><Ic n="check" s={14} />已喜欢</> : <><Ic n="heart" s={14} />{state === 'likedMe' ? '也喜欢' : '喜欢'}</>}
      </button>
      {node}
    </>
  );
}

/** 「2 小时前」「昨天」「3 天前」 */
export function agoText(iso: string | null): string {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return d === 1 ? '昨天' : d < 30 ? `${d} 天前` : new Date(iso).toLocaleDateString('zh-CN');
}

/** 下一批推荐什么时候来：「今天上午 10 点」/「明天上午 10 点」 */
export function nextText(iso: string): string {
  const d = new Date(iso);
  return `${d.toDateString() === new Date().toDateString() ? '今天' : '明天'}上午 ${d.getHours()} 点`;
}

/** 举报一个人：选原因 → 提交 */
const REPORT_REASONS = ['资料或照片是假的', '骚扰、辱骂', '借钱、投资、要转账', '发广告或引流', '色情低俗', '其他'];
export function ReportSheet({ userId, onClose, onDone }: { userId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const submit = async (reason: string) => {
    try {
      await api(`/match/report/${userId}`, { method: 'POST', body: { reason } });
      onDone('举报已提交，平台会尽快核实');
    } catch (e) {
      onDone((e as Error).message);
    }
    onClose();
  };
  return (
    <div className="hn-dim" onClick={onClose}>
      <div className="hn-sheet" onClick={(e) => e.stopPropagation()} style={{ paddingTop: 18 }}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>举报的原因</div>
        <div className="hn-t2" style={{ marginTop: 4 }}>对方不会知道是你举报的。</div>
        <div style={{ marginTop: 10 }}>
          {REPORT_REASONS.map((r) => <div key={r} className="hn-lr" style={{ padding: 0, borderBottom: '1px solid var(--hn-line)' }} onClick={() => submit(r)}>{r}<Ic n="right" style={{ marginLeft: 'auto', color: 'var(--hn-ink3)' }} /></div>)}
        </div>
        <button className="hn-btn flat" style={{ marginTop: 14, height: 46, fontSize: 15 }} onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
