import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, reasonOf } from '../api';
import { hnNative, openNativeChat, openNativeH5 } from '../bridge';
import { Ic, Nav, useBack, useToast } from '../hn';
import { useApp } from '../store';
import {
  Chevron, Confirm, Cover, LeaderAvatar, LeaderData, TripBtn, TripCard, TripCardData, TripDetail, openTripGroup, tripDate, useTripLive, yuan,
} from '../trip';

/**
 * 领队旅行给用户看的四页（样稿 design/13-travel.html 第 1～3 组）：
 *   TravelTab        大厅里的「旅行」tab：我的领队 + 「领队排行榜」入口 + 他的线路
 *   LeaderboardPage  /trip/leaders     领队排行榜，点一行进领队页
 *   LeaderPage       /trip/leader/:id  领队页
 *   TripDetailPage   /trip/:id         线路详情，底下「约单」→ 先弹一层说明 → 进线路群
 */

interface HomeData {
  leader: LeaderData | null;
  trips: TripCardData[];
  top: { id: string; nickname: string; avatar: string }[];
  /** 榜上一共几位领队 */
  leaders: number;
}

/** 大厅「旅行」tab */
export function TravelTab() {
  const nav = useNavigate();
  const [d, setD] = useState<HomeData | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<HomeData>('/trip/home').then((v) => { setD(v); setErr(''); }).catch((e: any) => setErr(e.message || '加载失败'));
  useEffect(() => { void load(); }, []);
  useTripLive(load);

  if (!d) return <div className="tp-empty">{err || '加载中…'}</div>;
  const l = d.leader;
  return (
    <>
      {l && (
        <div className="tp-ldr" data-act="my-leader" onClick={() => nav(`/trip/leader/${l.id}`)}>
          <LeaderAvatar u={l} size={52} />
          <div className="hn-grow">
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>{l.nickname}<span className="tp-mytag">{l.self ? '我自己' : '我的领队'}</span></div>
            <div className="hn-t2 tp-ell" style={{ marginTop: 3, fontSize: 12 }}>
              {[l.intro, `${l.trips} 条线路`, l.rank ? `排行榜第 ${l.rank} 名` : ''].filter(Boolean).join(' · ')}
            </div>
          </div>
          <Chevron />
        </div>
      )}
      {d.leaders > 0 && (
        <div className="tp-rkin" data-act="leaderboard" onClick={() => nav('/trip/leaders')}>
          <span className="cup"><Ic n="star" s={16} /></span><b>领队排行榜</b>
          <span className="stack">{d.top.map((u) => <LeaderAvatar key={u.id} u={u} size={26} />)}</span>
          <Chevron />
        </div>
      )}
      {d.trips.map((t, i) => <TripCard key={t.id} t={t} small={i > 0} onOpen={() => nav(`/trip/${t.id}`)} />)}
      {l && d.trips.length === 0 && <div className="tp-empty">{l.self ? '你还没有正在招募的线路。\n到「我的 → 领队后台」发布一条。' : `${l.nickname} 现在没有正在招募的线路。`}{d.leaders > 0 && !l.self ? '\n可以到排行榜看看别的领队。' : ''}</div>}
      {!l && <div className="tp-empty">{d.leaders > 0 ? '点上面的排行榜，看看领队们的线路。' : '还没有领队发布线路，过几天再来看看。'}</div>}
    </>
  );
}

interface BoardRow { rank: number; id: string; nickname: string; avatar: string; intro: string; trips: number; orders30: number; mine: boolean }

/** 领队排行榜：按最近 30 天约单的人数排 */
export function LeaderboardPage() {
  const nav = useNavigate();
  const back = useBack();
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const load = () => api<BoardRow[]>('/trip/leaders').then(setRows).catch(() => setRows((r) => r ?? []));
  useEffect(() => { void load(); }, []);
  useTripLive(load);

  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      <Nav title="领队排行榜" onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 20 }}>
        <div className="tp-rkhead"><i />按最近 30 天的约单人数排 · 有人约单马上更新</div>
        {rows?.map((r) => (
          <div key={r.id} className={`tp-rk${r.mine ? ' me' : ''}`} data-leader={r.id} onClick={() => nav(`/trip/leader/${r.id}`)}>
            <span className={`no${r.rank <= 3 ? ` t n${r.rank}` : ''}`}>{r.rank}</span>
            <LeaderAvatar u={r} size={44} />
            <div className="hn-grow">
              <b style={{ fontSize: 14.5 }}>{r.nickname}</b>{r.mine && <span className="tp-mytag">我的领队</span>}
              <div className="hn-t3 tp-ell" style={{ marginTop: 3, fontSize: 11.5 }}>{[r.intro, `${r.trips} 条线路`].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="num"><b>{r.orders30}</b><span>人约单</span></div>
          </div>
        ))}
        {rows && rows.length === 0 && <div className="tp-empty">榜上还没有领队。</div>}
        {!rows && <div className="tp-empty">加载中…</div>}
      </div>
    </div>
  );
}

/** 领队页：上面是这位领队，下面是他正在招募的线路 */
export function LeaderPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const back = useBack();
  const [toast, showToast] = useToast();
  const [d, setD] = useState<{ leader: LeaderData; trips: TripCardData[] } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<{ leader: LeaderData; trips: TripCardData[] }>(`/trip/leader/${id}`).then((v) => { setD(v); setErr(''); }).catch((e: any) => setErr(e.message || '打不开'));
  useEffect(() => { void load(); }, [id]);
  useTripLive(load);

  /** 发消息 = 和领队单聊（聊天是放开的） */
  const chat = async () => {
    if (!d) return;
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${d.leader.id}`, { method: 'POST' });
      if (openNativeChat(r.conversationId, 1, d.leader.id, d.leader.nickname)) return;
      nav(`/chatroom/${r.conversationId}`, { state: { title: d.leader.nickname, targetId: d.leader.id } });
    } catch (e: any) {
      showToast(e.message || '打不开聊天');
    }
  };

  if (!d) {
    return (
      <div className="hn-page" style={{ background: '#fbf7f5' }}>
        <Nav title="领队" onBack={back} />
        <div className="tp-empty">{err || '加载中…'}</div>
      </div>
    );
  }
  const l = d.leader;
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <div className="hn-scroll" style={{ paddingBottom: 20 }}>
        <div className="tp-lhero">
          <div className="bar">
            <span className="tp-gbtn" onClick={back}><Ic n="left" /></span>
            {/* 分享只给领队自己：用的是邀请名片那一套（别人从那里注册就绑定到他） */}
            {l.self && <span className="tp-gbtn" onClick={() => nav('/invite-card')}><Ic n="link" s={15} /></span>}
          </div>
        </div>
        <div className="tp-lcard">
          <div className="hn-row">
            <LeaderAvatar u={l} size={58} style={{ marginTop: -34 }} />
            {/* 昵称长的时候「认证领队」换到下一行，不跟着昵称一起被省略掉 */}
            <div className="hn-grow" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '3px 5px' }}>
              <span className="tp-ell" style={{ fontSize: 17, fontWeight: 800, maxWidth: '100%' }}>{l.nickname}</span>
              <span className="tp-cert" style={{ flexShrink: 0, marginLeft: 0 }}>认证领队</span>
            </div>
            {!l.self && <button className="tp-sbtn gh" style={{ height: 32, padding: '0 14px' }} data-act="chat" onClick={chat}><Ic n="chat" s={14} style={{ marginRight: 5 }} />发消息</button>}
          </div>
          {l.intro && <div className="hn-t2" style={{ marginTop: 8, lineHeight: 1.6, fontSize: 12.5 }}>{l.intro}</div>}
          <div className="tp-s3">
            <div><b>{l.rank ? `第 ${l.rank} 名` : '未上榜'}</b><span>排行榜</span></div>
            <div><b>{l.orders30}</b><span>近 30 天约单</span></div>
            <div><b>{l.trips}</b><span>招募中的线路</span></div>
          </div>
        </div>
        <div className="tp-lab">{l.self ? '我的线路' : '他的线路'}</div>
        {d.trips.map((t, i) => <TripCard key={t.id} t={t} small={i > 0} onOpen={() => nav(`/trip/${t.id}`)} />)}
        {d.trips.length === 0 && <div className="tp-empty" style={{ padding: '40px 30px' }}>现在没有正在招募的线路。</div>}
      </div>
    </div>
  );
}

/** 底下那个按钮上写什么、左边那两行小字写什么 */
const BTN: Record<TripBtn, { label: string; cls: string; hint: [string, string] }> = {
  order: { label: '约单', cls: '', hint: ['约单 = 进这条线路的群', '不付钱，随时可以退群'] },
  joined: { label: '进入群聊', cls: ' line', hint: ['你已经约单了', '细节在线路群里聊'] },
  owner: { label: '进入群聊', cls: ' line', hint: ['这是你的线路', '约单的人都在线路群里'] },
  full: { label: '名额已满', cls: ' off', hint: ['这条线路的名额满了', '可以看看别的线路'] },
  departed: { label: '已出发', cls: ' off', hint: ['这条线路已经出发了', '不能再约单'] },
  ended: { label: '已结束', cls: ' off', hint: ['这条线路已经结束了', ''] },
  blocked: { label: '不能约单', cls: ' off', hint: ['你已被移出这条线路的群', '不能再约这条线路'] },
  off: { label: '没上架', cls: ' off', hint: ['这条线路还没上架', '只有你自己看得到'] },
};

/** 线路详情 */
export function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const back = useBack();
  const me = useApp((s) => s.user);
  const [toast, showToast] = useToast();
  const [d, setD] = useState<TripDetail | null>(null);
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needKyc, setNeedKyc] = useState(false);
  const [params] = useSearchParams();
  const fromGroup = params.get('from') === 'group';
  const load = () => api<TripDetail>(`/trip/detail/${id}`).then((v) => { setD(v); setErr(''); }).catch((e: any) => { setErr(e.message || '打不开这条线路'); setD(null); });
  useEffect(() => { void load(); }, [id]);
  // 只关心这条线路的变化（约单人数、名额、内容、下架）
  useTripLive(load, (e) => e.event === 'trip' && e.tripId === id);

  const order = async () => {
    if (busy || !d) return;
    setBusy(true);
    try {
      const g = await api<{ groupId: string; conversationId: string; name: string }>(`/trip/detail/${d.id}/order`, { method: 'POST' });
      setAsking(false);
      void load();
      openTripGroup(nav, { id: g.groupId, conversationId: g.conversationId, name: g.name });
    } catch (e: any) {
      setAsking(false);
      // 约单要做过真人认证：带去认证，认证完回到这条线路
      if (reasonOf(e) === 'need_kyc') setNeedKyc(true);
      else { showToast(e.message || '约单没成功'); void load(); }
    }
    setBusy(false);
  };

  if (!d) {
    return (
      <div className="hn-page" style={{ background: '#fbf7f5' }}>
        <Nav title="线路" onBack={back} />
        <div className="tp-empty">{err || '加载中…'}</div>
      </div>
    );
  }
  const b = BTN[d.btn] ?? BTN.off;
  const click = () => {
    if (d.btn === 'order') return setAsking(true);
    if ((d.btn === 'joined' || d.btn === 'owner') && d.group) {
      // 是从这个线路群的聊天页顶上那张线路卡点进来的（?from=group）：群聊页就在下面一层，退回去就行，不再叠一层聊天页
      if (fromGroup) {
        if ((window.history.state?.idx ?? 0) > 0) return nav(-1);
        // App 里（原生群聊页打开的这一页网页）：把这一页关掉
        if (hnNative('close')) return;
      }
      return openTripGroup(nav, d.group);
    }
  };
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <div className="hn-scroll" style={{ paddingBottom: 96 }}>
        <div style={{ position: 'relative' }}>
          {/* 安卓 App 的内嵌网页不支持视频全屏（点了没反应），所以在那里不显示全屏按钮；下载按钮哪里都不要 */}
          <video
            className="tp-video" src={d.videoUrl} poster={d.coverUrl || undefined} controls playsInline preload="metadata"
            controlsList={(window as any).PeiwanNative ? 'nodownload nofullscreen' : 'nodownload'}
          />
          <span className="tp-gbtn" style={{ position: 'absolute', left: 14, top: 10, zIndex: 3 }} onClick={back}><Ic n="left" /></span>
        </div>
        <div className="tp-box" style={{ marginTop: -18, position: 'relative', zIndex: 5 }}>
          <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.4 }}>{d.title}</div>
          <div className="hn-row" style={{ marginTop: 8 }}>
            <span className="tp-price">{yuan(d.price)}<small>/ 人起</small></span>
            <span className="hn-grow" />
            <span className="hn-t2" style={{ fontSize: 12 }}>{tripDate(d.startDate)}出发 · {d.days} 天 · {d.gatherPlace}集合</span>
          </div>
          <div className="hn-row" style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--hn-line)' }}>
            {d.faces.length > 0 && <div className="tp-faces">{d.faces.map((f, i) => <div key={i} className="hn-meav" style={f ? { backgroundImage: `url(${f})` } : undefined} />)}</div>}
            <span className="hn-t2" style={{ fontSize: 12.5, marginLeft: d.faces.length ? 6 : 0 }} data-info="orders">{d.orders} 人已约单 · 名额 {d.quota}，{d.left > 0 ? `还剩 ${d.left} 位` : '已满'}</span>
          </div>
        </div>
        <div className="tp-box"><h5>行程</h5><p>{d.itinerary}</p></div>
        <div className="tp-box"><h5>费用</h5><p>{d.feeNote}</p></div>
        <div className="tp-box" style={{ cursor: 'pointer' }} onClick={() => nav(`/trip/leader/${d.leader.id}`)}>
          <div className="hn-row">
            <LeaderAvatar u={d.leader} size={38} />
            <div className="hn-grow">
              <b style={{ fontSize: 14 }}>{d.leader.nickname}</b><span className="tp-cert">认证领队</span>
              <div className="hn-t3 tp-ell" style={{ marginTop: 2 }}>{[d.leader.intro, `${d.leader.trips} 条线路`].filter(Boolean).join(' · ')}</div>
            </div>
            <Chevron />
          </div>
        </div>
        {d.btn === 'owner' && me?.id === d.leaderId && (
          <div className="tp-box" style={{ cursor: 'pointer' }} onClick={() => nav(`/leader/trip/${d.id}`)}>
            <div className="hn-row"><Ic n="pencil" s={17} style={{ color: 'var(--hn-rose)' }} /><b className="hn-grow" style={{ fontSize: 14 }}>管理这条线路</b><Chevron /></div>
          </div>
        )}
      </div>

      <div className="tp-dockb hn-glass">
        <div className="hn-grow" style={{ paddingLeft: 10 }}>
          <div className="hn-t3">{b.hint[0]}</div>
          <b style={{ fontSize: 13.5 }}>{b.hint[1]}</b>
        </div>
        <button className={`hn-btn${b.cls}`} style={{ height: 46, padding: '0 24px', fontSize: 15 }} data-act="trip-btn" data-btn={d.btn} disabled={b.cls === ' off'} onClick={click}>{b.label}</button>
      </div>

      {asking && (
        <div className="hn-dim" onClick={() => setAsking(false)}>
          <div className="hn-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="tp-hd" />
            <div style={{ fontSize: 19, fontWeight: 800 }}>约这条线路</div>
            <div className="hn-t2" style={{ marginTop: 4 }}>{d.title.split(/[：:]/)[0]} · {tripDate(d.startDate)}出发 · 领队 {d.leader.nickname}</div>
            <div className="tp-pt"><Ic n="chat" s={13} /><span><b>约单 = 进这条线路的群。</b>领队和已经约单的人都在群里，细节在群里问。</span></div>
            <div className="tp-pt"><Ic n="wallet" s={13} /><span><b>现在不付钱。</b>定金、尾款怎么付，由领队在群里跟你说。平台不代收。</span></div>
            <div className="tp-pt"><Ic n="shield" s={13} /><span>不想去了随时可以退群。<b>出发前不要给不认识的人私下转账</b>，有问题直接举报。</span></div>
            <button className="hn-btn" style={{ marginTop: 18, width: '100%' }} data-act="order-confirm" disabled={busy} onClick={order}>{busy ? '正在约单…' : '约单并进群'}</button>
            <div style={{ textAlign: 'center', color: 'var(--hn-ink2)', fontSize: 14, marginTop: 13, cursor: 'pointer' }} onClick={() => setAsking(false)}>再看看</div>
          </div>
        </div>
      )}
      {needKyc && (
        <Confirm
          title="先完成真人认证" body="约单要先做真人认证（身份证 + 刷脸），认证一次 1 牵豆。认证完回到这条线路。" ok="去认证"
          // 在 App 的大厅里：让 App 另开一页去认证（大厅的网页容器用不了摄像头），认证完那一页自己关掉，回到这里再点一次约单
          onOk={() => { if (!openNativeH5('/kyc?next=/me')) nav(`/kyc?next=${encodeURIComponent(`/trip/${d.id}`)}`); }} onClose={() => setNeedKyc(false)}
        />
      )}
    </div>
  );
}
