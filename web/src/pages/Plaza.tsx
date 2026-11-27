import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { api } from '../api';
import { CityPickerSheet } from '../components/CityPicker';
import { locateCity } from '../cities';
import { useApp } from '../store';
import { t } from '../i18n';
import { Ic } from '../hn';
import { MatchSummary, Quota, RelState, useLike } from '../match';
import { RecSection } from './Recommend';

export interface MomentItem {
  id: string;
  user: { id: string; nickname: string; avatar: string; age: number; online?: boolean; busy?: boolean; allowVideo?: boolean };
  content: string;
  type: number;
  images: string[];
  videoUrl: string;
  coverUrl: string;
  cityName: string;
  likeCount: number;
  commentCount: number;
  liked: boolean;
  isFollowing?: boolean;
  createdAt: string;
}

/** onOpenVideo：点视频交给调用方处理；不传则原地播放（广场现在不传，抖音模式已下线） */
export function MomentCard({ m, onOpenDetail, onGreet, onOpenVideo }: { m: MomentItem; onOpenDetail: () => void; onGreet: () => void; onOpenVideo?: () => void }) {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const isSelf = me?.id === m.user?.id;
  const [liked, setLiked] = useState(m.liked);
  const [likeCount, setLikeCount] = useState(m.likeCount);
  const [following, setFollowing] = useState(!!m.isFollowing);
  const [fullImage, setFullImage] = useState<string | null>(null);

  const toggleLike = async () => {
    try {
      const r = await api<{ liked: boolean }>(`/moments/${m.id}/like`, { method: 'POST' });
      setLiked(r.liked);
      setLikeCount((c) => c + (r.liked ? 1 : -1));
    } catch {}
  };

  const toggleFollow = async () => {
    try {
      const r = await api<{ following: boolean }>(`/user/${m.user.id}/follow`, { method: 'POST' });
      setFollowing(r.following);
    } catch {}
  };

  return (
    <div data-moment-id={m.id} style={{ padding: '14px 16px', borderBottom: '1px solid var(--line)' }}>
      {/* 头部：头像 昵称 时间 + 关注 */}
      <div className="row">
        {/* 点头像进入他人主页（自己的动态不跳转） */}
        <div
          className="avatar"
          style={{ width: 42, height: 42, cursor: isSelf ? 'default' : 'pointer' }}
          onClick={() => { if (!isSelf && m.user?.id) nav(`/u/${m.user.id}`); }}
        >
          {m.user?.avatar && <img src={m.user.avatar} alt="" />}
        </div>
        <div className="grow">
          <div style={{ fontSize: 15, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>{m.user?.nickname}</span>
            {m.cityName && (
              <span style={{ fontSize: 10, color: 'var(--text-3)', background: 'rgba(0,0,0,0.05)', padding: '1px 6px', borderRadius: 3 }}>{m.cityName}</span>
            )}
          </div>
          <div className="small" style={{ marginTop: 3 }}>{formatAgo(m.createdAt)}</div>
        </div>
        {/* 自己的动态不显示关注/视频通话按钮 */}
        {!isSelf && (
          <>
            <button
              onClick={toggleFollow}
              style={{
                height: 26, padding: '0 12px', borderRadius: 13, fontSize: 12, cursor: 'pointer',
                border: following ? '1px solid var(--line)' : 'none',
                background: following ? 'transparent' : 'var(--accent-grad)',
                color: following ? 'var(--text-2)' : '#fff',
              }}
            >
              {following ? t('common.followed') : t('common.follow')}
            </button>
            {/* 视频按钮（对方打开了视频见面才有）三态：通话中（占线）/ 离线置灰 / 可打 */}
            {m.user?.allowVideo && <button
              onClick={() => {
                if (m.user?.busy) return window.alert(t('common.peerBusy'));
                if (!m.user?.online) return window.alert(t('common.peerOffline'));
                window.alert(t('common.videoInApp'));
              }}
              style={{
                height: 26, padding: '0 12px', borderRadius: 13, fontSize: 12, cursor: 'pointer', marginLeft: 8,
                border: `1px solid ${m.user?.busy ? 'rgba(255,170,60,0.5)' : m.user?.online ? 'rgba(254,44,85,0.5)' : 'var(--line)'}`,
                background: 'transparent',
                color: m.user?.busy ? '#ffaa3c' : m.user?.online ? 'var(--accent)' : 'var(--text-3)',
              }}
            >
              {m.user?.busy ? t('common.inCall') : t('plaza.videoCall')}
            </button>}
          </>
        )}
      </div>

      {/* 文字点击进详情 */}
      {m.content && (
        <div onClick={onOpenDetail} style={{ cursor: 'pointer', marginTop: 10, fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{m.content}</div>
      )}
      {/* 图片点击直接放大查看；说明文字与图片间距 8，无文字时与头部保持 10 */}
      {m.type === 1 && m.images.length > 0 && (
        m.images.length === 1
          ? <img src={m.images[0]} onClick={() => setFullImage(m.images[0])} style={{ maxWidth: '80%', maxHeight: 360, borderRadius: 10, marginTop: m.content ? 8 : 10, display: 'block', cursor: 'zoom-in' }} alt="" />
          : <div className="grid-photos" style={{ marginTop: m.content ? 8 : 10 }}>{m.images.map((url, i) => <img key={i} src={url} onClick={() => setFullImage(url)} style={{ cursor: 'zoom-in' }} alt="" />)}</div>
      )}
      {fullImage && (
        <div
          onClick={() => setFullImage(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 999, background: 'rgba(0,0,0,0.92)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
          }}
        >
          <img src={fullImage} style={{ maxWidth: '96vw', maxHeight: '92vh', objectFit: 'contain' }} alt="" />
          <span style={{ position: 'absolute', top: 16, right: 20, color: '#fff', fontSize: 28, cursor: 'pointer' }}>×</span>
        </div>
      )}
      {m.type === 2 && m.videoUrl && onOpenVideo && (
        <div
          onClick={onOpenVideo}
          style={{
            position: 'relative', marginTop: m.content ? 8 : 10, height: 220, borderRadius: 10, overflow: 'hidden',
            background: '#000', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          {m.coverUrl
            ? <img src={m.coverUrl} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
            : <video src={`${m.videoUrl}#t=0.1`} muted playsInline preload="metadata" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />}
          <span style={{ position: 'relative', color: '#fff', fontSize: 34, textShadow: '0 2px 8px rgba(0,0,0,0.4)' }}>▶</span>
        </div>
      )}
      {m.type === 2 && m.videoUrl && !onOpenVideo && (
        <video
          src={m.videoUrl}
          poster={m.coverUrl || undefined}
          controls
          playsInline
          onPlay={(e) => {
            // 互斥播放：开播时暂停页面上其它视频
            document.querySelectorAll('video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
          }}
          style={{ width: '100%', borderRadius: 10, marginTop: m.content ? 8 : 10, maxHeight: 400, background: '#000' }}
        />
      )}

      {/* 操作行：左侧 在线状态，右侧 点赞 / 评论 */}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 12, gap: 18 }}>
        <span style={{ fontSize: 12, color: m.user?.online ? '#0bd07d' : 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: m.user?.online ? '#0bd07d' : 'var(--text-3)', display: 'inline-block' }} />
          {m.user?.online ? t('common.online') : t('common.offline')}
        </span>
        <span style={{ flex: 1 }} />
        <span
          className={`muted${liked ? ' accent' : ''}`}
          style={{ cursor: 'pointer', fontSize: 13, color: liked ? 'var(--accent)' : undefined }}
          onClick={toggleLike}
        >
          {liked ? '♥' : '♡'} {t('plaza.like')}{likeCount > 0 ? ` ${likeCount}` : ''}
        </span>
        <span className="muted" style={{ cursor: 'pointer', fontSize: 13 }} onClick={onOpenDetail}>
          {t('plaza.comment')}{m.commentCount > 0 ? ` ${m.commentCount}` : ''}
        </span>
      </div>
    </div>
  );
}

function formatAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.minutesAgo', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { n: days });
  return new Date(iso).toLocaleDateString('zh-CN');
}

const DEFAULT_CITY = '成都';

/** 遇见列表用户卡片（/user/meet/list） */
interface MeetUser {
  id: string;
  nickname: string;
  avatar: string;
  gender: number;
  age: number;
  cityName: string;
  realnameVerified: boolean;
  ratingAvg: number;
  ratingCount: number;
  allowVideo?: boolean;
  online: boolean;
  busy: boolean;
  isNew: boolean;
  intimacy: number;
  /** none 都没表态 | liked 我喜欢了 | likedMe 对方喜欢了我 | mutual 互相喜欢 */
  like?: RelState;
}

const MEET_TABS = [
  // 每日推荐排在最前面，点「遇见」先看到它
  ['rec', '推荐'],
  ['all', t('plaza.meetAll')],
  ['new', t('plaza.meetNew')],
  ['city', t('plaza.meetCity')],
  ['intimacy', t('plaza.meetIntimacy')],
] as const;

/** 遇见：异性卡片流（所有/新人/同城/亲密度），亲密度按互动记分倒序 */
function MeetSection({ city }: { city: string }) {
  const nav = useNavigate();
  // 记住停在哪个小标签：看完别人的画像回来还在原来的地方
  const [tab, setTabState] = useState<string>(() => sessionStorage.getItem('hn_meet_tab') || 'rec');
  const setTab = (k: string) => { sessionStorage.setItem('hn_meet_tab', k); setTabState(k); };
  const [items, setItems] = useState<MeetUser[]>([]);
  const [loading, setLoading] = useState(true);
  /** 在这几个列表里自己点喜欢的名额（每天几个，后台可调；「推荐」里的不占） */
  const [quota, setQuota] = useState<Quota | null>(null);
  const { like, busy, node } = useLike();

  useEffect(() => {
    if (tab === 'rec') return;
    setLoading(true);
    const q = tab === 'city' && city ? `?tab=city&city=${encodeURIComponent(city)}` : `?tab=${tab}`;
    api<MeetUser[]>(`/user/meet/list${q}`)
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
    api<MatchSummary>('/match/summary').then((s) => setQuota(s.quota)).catch(() => {});
  }, [tab, city]);

  const onHeart = async (u: MeetUser) => {
    // 已经喜欢过的：进画像看（取消喜欢、发消息都在那里）
    if (busy || u.like === 'liked' || u.like === 'mutual') return nav(`/u/${u.id}`);
    const r = await like(u.id);
    if (!r) return;
    setItems((list) => list.map((x) => (x.id === u.id ? { ...x, like: r.state } : x)));
    setQuota(r.quota);
  };

  return (
    <div>
      {/* 子栏胶囊 */}
      <div style={{ display: 'flex', gap: 8, padding: '2px 16px 10px' }}>
        {MEET_TABS.map(([k, label]) => (
          <span
            key={k}
            onClick={() => setTab(k)}
            style={{
              fontSize: 13, cursor: 'pointer', padding: '5px 14px', borderRadius: 15,
              background: tab === k ? 'var(--accent-grad)' : 'var(--bg-card)',
              color: tab === k ? '#fff' : 'var(--text-2)',
              fontWeight: tab === k ? 700 : 400,
            }}
          >
            {label}
          </span>
        ))}
      </div>
      {tab === 'rec' && <RecSection onBrowse={() => setTab('all')} />}
      {tab !== 'rec' && quota && items.length > 0 && (
        <div className="small" style={{ padding: '0 18px 8px' }}>
          点 ♥ 喜欢，互相喜欢后可以视频见面 · 今天还能喜欢 {quota.left} 个
        </div>
      )}
      {tab !== 'rec' && !loading && items.length === 0 && (
        <div className="empty">
          {tab === 'intimacy'
            ? t('plaza.noIntimate')
            : tab === 'city' ? t('plaza.nobodyInCity', { city: city || t('plaza.meetCity') }) : t('plaza.nobody')}
          <br />
          {tab === 'intimacy' && <span className="small">{t('plaza.intimacyTip')}</span>}
        </div>
      )}
      {/* 两列大图卡片 */}
      <div style={{ display: tab === 'rec' ? 'none' : 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: '0 12px 12px' }}>
        {items.map((u) => (
          <div
            key={u.id}
            onClick={() => nav(`/u/${u.id}`)}
            style={{ position: 'relative', aspectRatio: '3/4', borderRadius: 14, overflow: 'hidden', background: 'var(--bg-card)', cursor: 'pointer' }}
          >
            {u.avatar && <img src={u.avatar} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            {/* 顶部徽章 + 在线点 */}
            <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 5 }}>
              {u.realnameVerified ? (
                <span style={{ fontSize: 10, color: '#fff', background: 'var(--accent)', padding: '2px 7px', borderRadius: 9 }}>{t('plaza.verifiedBadge')}</span>
              ) : u.isNew ? (
                <span style={{ fontSize: 10, color: '#fff', background: '#6c5ce7', padding: '2px 7px', borderRadius: 9 }}>{t('plaza.newBadge')}</span>
              ) : null}
            </div>
            {/* 喜欢：互相喜欢后可以视频见面（发消息不用喜欢，点头像进画像页就能发）。实心 = 我已经喜欢了 */}
            <button
              className={`hn-heart${u.like === 'liked' || u.like === 'mutual' ? ' on' : ''}`}
              title={u.like === 'likedMe' ? '对方喜欢了你' : '喜欢'}
              onClick={(e) => { e.stopPropagation(); onHeart(u); }}
            ><Ic n="heart" s={17} /></button>
            {u.like === 'likedMe' && (
              <span style={{ position: 'absolute', top: 46, right: 8, fontSize: 10, color: '#fff', background: 'var(--accent)', padding: '2px 7px', borderRadius: 9 }}>喜欢了你</span>
            )}
            <span style={{ position: 'absolute', top: 10, left: u.realnameVerified || u.isNew ? 56 : 10, width: 8, height: 8, borderRadius: 4, background: u.online ? '#0bd07d' : 'var(--text-3)' }} />
            {/* 底部信息浮层 */}
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '26px 10px 9px', background: 'linear-gradient(transparent, rgba(0,0,0,0.8))' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.nickname}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
                {/* 评分五星换算（0-100 → 5.0） */}
                <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(255,184,0,0.85)', padding: '1px 6px', borderRadius: 8 }}>
                  ★ {u.ratingCount > 0 ? (u.ratingAvg / 20).toFixed(1) : t('plaza.newRating')}
                </span>
                {u.cityName && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.75)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.cityName}</span>}
                <span style={{ flex: 1 }} />
                {tab === 'intimacy' && u.intimacy > 0 ? (
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: 'rgba(254,44,85,0.9)', padding: '1px 6px', borderRadius: 8 }}>
                    ♥ {u.intimacy % 1 === 0 ? u.intimacy : u.intimacy.toFixed(1)}
                  </span>
                ) : u.allowVideo ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      if (u.busy) return window.alert(t('common.peerBusy'));
                      if (!u.online) return window.alert(t('common.peerOffline'));
                      window.alert(t('common.videoInApp'));
                    }}
                    style={{
                      fontSize: 11, fontWeight: 700, color: '#fff', padding: '3px 8px', borderRadius: 10,
                      background: u.busy ? 'rgba(255,170,60,0.9)' : u.online ? 'var(--accent)' : 'rgba(74,74,82,0.8)',
                    }}
                  >
                    {u.busy ? t('common.inCall') : t('plaza.video')}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
      {node}
    </div>
  );
}

export function PlazaPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<MomentItem[]>([]);
  // 记住停在「动态」还是「遇见」：看完别人的画像回来还在原来的地方。网址带 ?tab=meet 直接进遇见（&sub=all 指定小标签）
  const [params] = useSearchParams();
  const [tab, setTabState] = useState<'feed' | 'meet'>(() => {
    const sub = params.get('sub');
    if (sub) sessionStorage.setItem('hn_meet_tab', sub);
    return (params.get('tab') ?? sessionStorage.getItem('hn_plaza_tab')) === 'meet' ? 'meet' : 'feed';
  });
  const setTab = (k: 'feed' | 'meet') => { sessionStorage.setItem('hn_plaza_tab', k); setTabState(k); };
  const [city, setCity] = useState('');
  const [showCity, setShowCity] = useState(false);
  const [loading, setLoading] = useState(true);

  // 定位城市，失败默认成都
  useEffect(() => {
    const saved = localStorage.getItem('pw_city');
    if (saved) {
      setCity(saved);
      return;
    }
    locateCity().then((located) => setCity(located ?? DEFAULT_CITY));
  }, []);

  // 离开广场页（跳详情等路由切换）时停止所有正在播放的视频
  useEffect(() => () => {
    document.querySelectorAll('video').forEach((v) => v.pause());
  }, []);

  useEffect(() => {
    if (tab !== 'feed') return;
    setLoading(true);
    api<MomentItem[]>('/moments/feed')
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tab]);

  const greet = async (m: MomentItem) => {
    try {
      const r = await api<{ conversationId: string }>(`/im/conversations/open/${m.user.id}`, { method: 'POST' });
      if (openNativeChat(r.conversationId, 1, m.user.id, m.user.nickname)) return;
      nav(`/chatroom/${r.conversationId}`, { state: { title: m.user.nickname, targetId: m.user.id } });
    } catch (e: any) {
      alert(e.message);
    }
  };

  return (
    <>
      <div className="top-tabs">
        <span className={`top-tab${tab === 'feed' ? ' active' : ''}`} onClick={() => setTab('feed')}>{t('plaza.tabFeed')}</span>
        <span className={`top-tab${tab === 'meet' ? ' active' : ''}`} onClick={() => setTab('meet')}>{t('plaza.tabMeet')}</span>
        <span className="top-right" onClick={() => setShowCity(true)}>{city || t('plaza.locatingWeb')} ▾</span>
      </div>
      {tab === 'meet' && <MeetSection city={city} />}
      {tab === 'feed' && !loading && items.length === 0 && (
        <div className="empty">
          {t('plaza.feedEmpty')}
          <br />
          {t('plaza.feedEmptyHint')}
          <br />
          <span className="small">{t('plaza.feedEmptyTip')}</span>
        </div>
      )}
      {tab === 'feed' && items.map((m) => (
        <MomentCard key={m.id} m={m} onOpenDetail={() => nav(`/moment/${m.id}`)} onGreet={() => greet(m)} />
      ))}
      {showCity && (
        <CityPickerSheet
          current={city}
          onClose={() => setShowCity(false)}
          onSelect={(selected) => {
            setCity(selected);
            localStorage.setItem('pw_city', selected);
            setShowCity(false);
          }}
        />
      )}
    </>
  );
}
