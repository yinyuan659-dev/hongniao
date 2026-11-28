import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { NavigateFunction } from 'react-router-dom';
import { api } from './api';
import { openNativeChat } from './bridge';
import { Ic } from './hn';
import { wsManager } from './ws';
import './hn.css';
import './trip.css';

/**
 * 领队旅行（第 2 步）在网页端共用的类型和小零件。样稿 design/13-travel.html，用户 2026-11-28 过关。
 * 这几页在 App 里也是用内嵌网页打开的（和大厅一样），所以三端是同一份代码。
 * 规则都在后端（houduan/src/trip/trip.service.ts）。数据的变化服务器会推 { op: 'trip', data: { event, tripId?, leaderId? } }，
 * 页面收到就重新取一次（useTripLive），不轮询。
 */

/** 上架以后按日期算的：open 招募中 | departed 已出发 | ended 已结束 */
export type TripPhase = 'open' | 'departed' | 'ended';

/** 线路卡上用的那些 */
export interface TripCardData {
  id: string;
  leaderId: string;
  title: string;
  videoUrl: string;
  coverUrl: string;
  /** 出发日期 YYYY-MM-DD（北京时间） */
  startDate: string;
  days: number;
  gatherPlace: string;
  /** 起价，元 */
  price: number;
  quota: number;
  /** 还剩几位 = 总名额 - 领队记的「已经定下来的人数」 */
  left: number;
  /** 几人已约单 */
  orders: number;
  phase: TripPhase;
}

export interface LeaderData {
  id: string;
  nickname: string;
  avatar: string;
  /** 一句话介绍（平台审过的） */
  intro: string;
  /** 排行榜第几名；没上榜（没有招募中的线路）是 null */
  rank: number | null;
  /** 最近 30 天约单的人数 */
  orders30: number;
  /** 招募中的线路数 */
  trips: number;
  /** 是不是我自己 */
  self?: boolean;
  /** 是不是「我的领队」 */
  mine?: boolean;
}

/** 约单以后要进的那个群 */
export interface TripGroup { id: string; conversationId: string; name: string }

/** 底下那个按钮的样子（后端算好的） */
export type TripBtn = 'order' | 'joined' | 'owner' | 'full' | 'departed' | 'ended' | 'blocked' | 'off';

export interface TripDetail extends TripCardData {
  itinerary: string;
  feeNote: string;
  /** 0 审核中 1 已上架 2 没通过 3 领队下架 4 平台下架 */
  status: number;
  leader: LeaderData;
  /** 最近约单的几个人的头像 */
  faces: string[];
  btn: TripBtn;
  group: TripGroup | null;
}

/** 「12 月 6 日」；不是今年的带上年份 */
export function tripDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return `${y !== new Date().getFullYear() ? `${y} 年 ` : ''}${m} 月 ${d} 日`;
}

export const yuan = (n: number) => `¥${n.toLocaleString('en-US')}`;

/** 进线路群：在 App 里交给原生的群聊页，在浏览器里进网页的聊天页 */
export function openTripGroup(nav: NavigateFunction, g: TripGroup) {
  if (openNativeChat(g.conversationId, 2, g.id, g.name)) return;
  nav(`/chatroom/${g.conversationId}`, { state: { title: g.name, groupId: g.id } });
}

let watching = 0;

/**
 * 旅行的页面用它：打开时取一次（页面自己做），之后服务器推了 { op: 'trip' } 就调 reload 重新取；断线重连后也补取一次。
 * only：只关心哪些事（不传 = 都关心）。
 */
export function useTripLive(reload: () => void, only?: (data: { event: string; tripId?: string; leaderId?: string; pass?: boolean; on?: boolean }) => boolean) {
  const fn = useRef(reload);
  fn.current = reload;
  const want = useRef(only);
  want.current = only;
  useEffect(() => {
    wsManager.connect();
    // 几个页面叠着的时候只登记一次，最后一个离开才取消
    if (watching++ === 0) wsManager.watch('trip', true);
    const off = wsManager.on((frame) => {
      if (frame.op === 'ws_reopen') {
        wsManager.watch('trip', true);
        fn.current();
      } else if (frame.op === 'trip' && (!want.current || want.current(frame.data ?? {}))) {
        fn.current();
      }
    });
    return () => {
      off();
      if (--watching === 0) wsManager.watch('trip', false);
    };
  }, []);
}

/** 领队头像：有头像用头像，没有的画一个带昵称第一个字的圆 */
export function LeaderAvatar({ u, size = 44, style }: { u: { nickname: string; avatar: string }; size?: number; style?: CSSProperties }) {
  return (
    <div className="tp-av" style={{ width: size, height: size, fontSize: Math.round(size * 0.37), ...(u.avatar ? { backgroundImage: `url(${u.avatar})` } : {}), ...style }}>
      {u.avatar ? '' : u.nickname.slice(0, 1)}
    </div>
  );
}

/** 视频封面那一块：有封面用封面，没有用默认的色块 */
export function Cover({ url, height, className = '', style, children }: { url?: string; height?: number; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={`tp-cv ${className}`} style={{ ...(height ? { height } : {}), ...(url ? { backgroundImage: `url(${url})` } : {}), ...style }}>
      {children}
    </div>
  );
}

/** 线路卡（旅行首页、领队页共用）：点卡片进详情，点「约单」也是进详情（在那里弹确认） */
export function TripCard({ t, onOpen, small }: { t: TripCardData; onOpen: () => void; small?: boolean }) {
  return (
    <div className="tp-trip" data-trip={t.id} onClick={onOpen}>
      <Cover url={t.coverUrl} height={small ? 104 : 140} className="shade"><span className="tp-play" /></Cover>
      <div className="in">
        <h4>{t.title}</h4>
        <div className="tp-meta">
          <span className="hot">{tripDate(t.startDate)}出发</span>
          <span>{t.gatherPlace}集合</span>
          <span>{t.days} 天</span>
          <span>{t.orders} 人已约单</span>
          <span>{t.left > 0 ? `还剩 ${t.left} 位` : '名额已满'}</span>
        </div>
        <div className="hn-row" style={{ marginTop: 10 }}>
          <span className="tp-price">{yuan(t.price)}<small>/ 人起</small></span>
          <span className="hn-grow" />
          <span className={`tp-sbtn${t.left > 0 ? '' : ' off'}`}>{t.left > 0 ? '约单' : '名额已满'}</span>
        </div>
      </div>
    </div>
  );
}

/** 线路的状态小标：reviewing 审核中 | open 招募中 | departed 已出发 | ended 已结束 | rejected 没通过 | off 已下架 */
export function TripState({ state }: { state: string }) {
  const [cls, label] = state === 'reviewing' ? ['wait', '审核中'] : state === 'open' ? ['on', '招募中'] : state === 'departed' ? ['on', '已出发']
    : state === 'rejected' ? ['no', '没通过'] : state === 'ended' ? ['off', '已结束'] : ['off', '已下架'];
  return <span className={`tp-st ${cls}`}>{label}</span>;
}

/** 确认框（屏幕中间）：标题、一句说明、取消 / 确定 */
export function Confirm({ title, body, ok, onOk, onClose }: { title: string; body: string; ok: string; onOk: () => void; onClose: () => void }) {
  return (
    <div className="hn-dim center" onClick={onClose}>
      <div className="hn-dialog" style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16.5, fontWeight: 800 }}>{title}</div>
        <div className="hn-t2" style={{ fontSize: 13.5, lineHeight: 1.65, marginTop: 8 }}>{body}</div>
        <div className="hn-row" style={{ marginTop: 16 }}>
          <button className="hn-btn flat" style={{ height: 44, fontSize: 14.5, flex: 1 }} onClick={onClose}>取消</button>
          <button className="hn-btn" style={{ height: 44, fontSize: 14.5, flex: 1 }} onClick={() => { onClose(); onOk(); }}>{ok}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 线路群的聊天页顶上钉着的那张线路卡（样稿第 3 组右屏）：点了回线路详情。
 * 线路已经不在了（下架了、不是自己的）就不显示。
 */
export function TripPin({ tripId, onOpen }: { tripId: string; onOpen: () => void }) {
  const [t, setT] = useState<TripCardData | null>(null);
  useEffect(() => {
    let alive = true;
    api<TripCardData>(`/trip/detail/${tripId}`).then((v) => alive && setT(v)).catch(() => alive && setT(null));
    return () => { alive = false; };
  }, [tripId]);
  if (!t) return null;
  return (
    <div data-info="trip-pin" onClick={onOpen} style={{ margin: '0 12px 8px', borderRadius: 16, background: '#fff', padding: '9px 12px', display: 'flex', gap: 10, alignItems: 'center', boxShadow: '0 4px 14px rgba(43, 28, 34, 0.07)', cursor: 'pointer', flexShrink: 0 }}>
      <Cover url={t.coverUrl} style={{ width: 46, height: 46, borderRadius: 12, flexShrink: 0 }} />
      <div className="hn-grow">
        <b className="tp-ell" style={{ fontSize: 13.5, display: 'block', color: 'var(--hn-ink)' }}>{t.title}</b>
        <div className="tp-ell" style={{ marginTop: 3, fontSize: 11, color: 'var(--hn-ink3)' }}>{tripDate(t.startDate)}出发 · {yuan(t.price)} / 人起</div>
      </div>
      <span style={{ fontSize: 12.5, color: 'var(--hn-ink2)', whiteSpace: 'nowrap' }}>看线路 ›</span>
    </div>
  );
}

/** 右箭头 */
export const Chevron = () => <Ic n="right" s={15} style={{ color: 'var(--hn-ink3)' }} />;
