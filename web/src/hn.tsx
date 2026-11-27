import { CSSProperties, ReactNode, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { hnNative, inNativeApp } from './bridge';
import './hn.css';

/** 网站的 ICP 备案号（2026-11-26 管局审核通过）。换号只改这一处 */
export const ICP_NO = '蜀ICP备2024113063号-4';

/**
 * 页面底部中间的备案号，点了去工信部的备案查询网站（备案要求：网站首页底部要挂）。
 * 放在没登录的人最先看到的两页：注册页、「重新进入」页。
 * App 里的网页不显示：这是网站的号，App 有自己的备案号；App 内也只打开我们自己的网页。
 */
export function IcpFooter() {
  if (inNativeApp()) return null;
  return (
    <div className="icp-foot">
      <a href="https://beian.miit.gov.cn" target="_blank" rel="noopener noreferrer">{ICP_NO}</a>
    </div>
  );
}

/** AI 红娘新页面（深聊、相亲画像网页、AI 费用）共用的小零件：线条图标、头像小球、提示条、类型 */

/** 线条小图标（画法参考 lucide） */
const IC: Record<string, string> = {
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  spark: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  pin: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  cap: '<path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
  bag: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  cake: '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8"/><path d="M4 16s.5-1 2-1 2.5 2 4 2 2.5-2 4-2 2.5 2 4 2 2-1 2-1"/><path d="M2 21h20"/><path d="M7 8v3"/><path d="M12 8v3"/><path d="M17 8v3"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  baby: '<path d="M9 12h.01"/><path d="M15 12h.01"/><path d="M10 16c.5.3 1.2.5 2 .5s1.5-.2 2-.5"/><path d="M19 6.3a9 9 0 0 1 1.8 3.9 2 2 0 0 1 0 3.6 9 9 0 0 1-17.6 0 2 2 0 0 1 0-3.6A9 9 0 0 1 12 3c2 0 3.5 1.1 3.5 2.5s-.9 2.5-2 2.5c-.8 0-1.5-.4-1.5-1"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  cup: '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/><path d="M6 2v2"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  clip: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  doc: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

export function Ic({ n, s = 16, style }: { n: string; s?: number; style?: CSSProperties }) {
  return (
    <i className="hn-ic" style={style}>
      <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: IC[n] ?? '' }} />
    </i>
  );
}

/** AI 红娘的头像 */
export function Orb({ size }: { size?: 'sm' | 'lg' }) {
  return <div className={`hn-orb${size ? ` ${size}` : ''}`}><Ic n="heart" s={size === 'lg' ? 28 : size === 'sm' ? 13 : 18} /></div>;
}

/** 顶上弹一下就消失的提示 */
export function useToast(): [ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState('');
  const show = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2400);
  }, []);
  return [msg ? <div className="hn-toast">{msg}</div> : null, show];
}

/**
 * 返回上一页。在 App 的内嵌网页里，如果这已经是打开的第一页，再返回就是关掉网页回到原生页面。
 * （react-router 把「这是第几页」记在 history.state.idx 里，第一页是 0）
 */
export function useBack() {
  const nav = useNavigate();
  return useCallback(() => {
    if ((window.history.state?.idx ?? 0) === 0 && hnNative('close')) return;
    nav(-1);
  }, [nav]);
}

/** 子页面顶栏：返回 + 标题 + 右边可选的一个按钮 */
export function Nav({ title, onBack, right, badge }: { title: string; onBack: () => void; right?: ReactNode; badge?: string }) {
  return (
    <div className="hn-nav">
      <button className="hn-icbtn" onClick={onBack}><Ic n="left" /></button>
      <div className="mid">{title}{badge && <span className="hn-aib">{badge}</span>}</div>
      {right ?? <span style={{ width: 34 }} />}
    </div>
  );
}

// ---------- 接口返回的类型 ----------

export interface AiWalletView {
  balance: string;
  balanceMicro: number;
  payMode: 'platform' | 'own';
  key: { tail: string; checkedAt: string | null } | null;
  autoFallback: boolean;
  feePercent: number;
  canTopup: boolean;
  /** 充值档位（牵豆 = 元） */
  topupAmounts?: number[];
  /** 视频见面每分钟多少牵豆（男方付）；'0.00' = 不收费 */
  videoPerMin?: string;
  model: string;
}

export interface CardChip {
  key: string;
  label: string;
  text: string;
  empty: boolean;
  from?: 'basic' | 'deep';
}

export interface CardData {
  self: boolean;
  user: { id: string; nickname: string; avatar: string; gender: number; age: number; cityName: string };
  /** 做过实人认证：画像上显示「真人认证」绿标 */
  realname: boolean;
  photos: string[];
  hero: string[];
  profileDone: boolean;
  ai: { byAi: boolean; draft: boolean; summary: string; tags: string[] } | null;
  intro: string;
  facts: CardChip[];
  hobbies: string[];
  partner: string;
  prefs: CardChip[];
  /** AI 深聊整理的每一行（性格、生活、花钱、家庭、感情、不能接受）：别人看到的和自己看到的一样 */
  rows: { key: string; label: string; text: string }[];
  /** 需要注意的事：AI 在深聊里听到本人自己说的严重问题，本人改不了 */
  flags: string[];
  deepStatus: 'none' | 'chatting' | 'draft' | 'done' | null;
  isFollowing: boolean;
  /** 我和 TA 的关系、共同点、为什么推荐给我（看自己时是 null）。类型在 match.tsx 的 CardMatch */
  match: import('./match').CardMatch | null;
}

/** AI 功能两种付费方式的选择卡片：用牵豆 / 用自己的 Key（深聊开始前的说明、牵豆页、Key 页共用） */
export function PayOptions({ wallet, onPick, onGoKey, onGoTopup }: {
  wallet: { balance: string; payMode: 'platform' | 'own'; hasKey: boolean; feePercent: number };
  onPick: (mode: 'platform' | 'own') => void;
  onGoKey: () => void;
  onGoTopup?: () => void;
}) {
  const own = wallet.payMode === 'own' && wallet.hasKey;
  const empty = Number(wallet.balance) <= 0;
  return (
    <>
      <div className={`hn-pay${own ? '' : ' on'}`} onClick={() => onPick('platform')}>
        <span className="hn-sq"><Ic n="wallet" s={18} /></span>
        <div className="hn-grow">
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>用牵豆付 <span className="hn-num" style={{ fontWeight: 500, color: 'var(--hn-ink2)' }}>现有 {wallet.balance}</span></div>
          <div className="hn-t3" style={{ marginTop: 2 }}>DeepSeek 实际费用 + {wallet.feePercent}% 手续费</div>
        </div>
        {empty && onGoTopup
          ? <span style={{ fontSize: 13, color: 'var(--hn-rose)', fontWeight: 600 }} onClick={(e) => { e.stopPropagation(); onGoTopup(); }}>去充值</span>
          : <span className="hn-ck">{!own && <Ic n="check" s={12} />}</span>}
      </div>
      <div className={`hn-pay${own ? ' on' : ''}`} onClick={() => (wallet.hasKey ? onPick('own') : onGoKey())}>
        <span className="hn-sq"><Ic n="key" s={18} /></span>
        <div className="hn-grow">
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>我自己的 DeepSeek Key</div>
          <div className="hn-t3" style={{ marginTop: 2 }}>用你自己的额度，平台不扣牵豆</div>
        </div>
        {wallet.hasKey
          ? <span className="hn-ck">{own && <Ic n="check" s={12} />}</span>
          : <span style={{ fontSize: 13, color: 'var(--hn-rose)', fontWeight: 600 }}>去填写</span>}
      </div>
    </>
  );
}

/** 聊天里的画像卡片：像别人发来的一条网页链接，点开是相亲画像网页 */
export function PortraitLink({ card, onOpen }: { card: CardData; onOpen: () => void }) {
  return (
    <div className="hn-link" onClick={onOpen}>
      <div className="cover" style={card.photos[0] ? { backgroundImage: `url(${card.photos[0]})` } : undefined}>
        <div className="txt">
          <div style={{ fontSize: 20, fontWeight: 800 }}>{card.user.nickname} <span style={{ fontWeight: 500, fontSize: 17 }}>{card.user.age || ''}</span></div>
          <div className="hn-row" style={{ gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
            {card.hero.slice(0, 4).map((h) => <span key={h} className="hn-chipg">{h}</span>)}
          </div>
        </div>
      </div>
      <div style={{ padding: '12px 14px 13px' }}>
        <div style={{ fontSize: 15.5, fontWeight: 800 }}>{card.user.nickname}的相亲画像</div>
        <div className="hn-t2" style={{ marginTop: 4, lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{card.ai?.summary}</div>
        <div className="hn-row" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--hn-line)', fontSize: 12, color: 'var(--hn-rose)', fontWeight: 600, gap: 5 }}>
          <Ic n="link" s={13} />点开查看完整画像<Ic n="right" s={14} style={{ marginLeft: 'auto' }} />
        </div>
      </div>
    </div>
  );
}
