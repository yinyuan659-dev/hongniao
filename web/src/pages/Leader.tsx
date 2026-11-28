import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, reasonOf, uploadBlob } from '../api';
import { AiWalletView, Ic, Nav, Orb, useBack, useToast } from '../hn';
import { useApp } from '../store';
import { Chevron, Confirm, Cover, LeaderAvatar, TripCardData, TripDetail, TripState, openTripGroup, tripDate, useTripLive, yuan } from '../trip';

/**
 * 领队后台（样稿 design/13-travel.html 第 4、5 组）。入口在「我的 → 领队后台」，只有平台设成领队的人看得到。
 *   LeaderHomePage     /leader                  四个数、我的领队页（改介绍）、分享、我的线路
 *   LeaderTripPage     /leader/trip/:id         管一条线路：名额、约单的人、进群、改内容、下架
 *   LeaderOrdersPage   /leader/trip/:id/orders  约单的人
 *   LeaderPublishPage  /leader/publish[?id=]    发布 / 修改线路：默认和 AI 聊，右上角切到表单（兜底）
 */

interface MineTrip extends TripCardData {
  confirmed: number;
  /** reviewing 审核中 | open 招募中 | departed 已出发 | ended 已结束 | rejected 没通过 | off 已下架 */
  state: string;
  rejectReason: string;
  /** 上架以后又改了内容、在等审核 */
  hasPending: boolean;
}
interface MineData {
  rank: number | null; orders30: number; invited: number; rate: number;
  intro: string; introPending: string | null; trips: MineTrip[];
}

/** 平台写的原因后面要接一句话：把原因末尾的标点去掉，由页面统一加句号 */
const why = (s: string) => s.replace(/[。.！!；;，,、\s]+$/, '');

function useMine() {
  const [d, setD] = useState<MineData | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<MineData>('/trip/mine').then((v) => { setD(v); setErr(''); }).catch((e: any) => setErr(e.message || '加载失败'));
  useEffect(() => { void load(); }, []);
  // 审核结果、约单、名额、被取消领队：都重新取
  useTripLive(load);
  return { d, err, load, setD };
}

/** 领队后台首页 */
export function LeaderHomePage() {
  const nav = useNavigate();
  const back = useBack();
  const me = useApp((s) => s.user);
  const [toast, showToast] = useToast();
  const { d, err, load } = useMine();
  const [intro, setIntro] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveIntro = async () => {
    if (intro === null || busy) return;
    setBusy(true);
    try {
      const r = await api<{ introPending: string | null }>('/trip/intro', { method: 'POST', body: { intro } });
      setIntro(null);
      showToast(r.introPending === null ? '没有改动' : '已提交，平台看过以后显示');
      void load();
    } catch (e: any) {
      showToast(e.message || '没保存成功');
    }
    setBusy(false);
  };

  if (!d) {
    return (
      <div className="hn-page" style={{ background: '#fbf7f5' }}>
        <Nav title="领队后台" onBack={back} />
        <div className="tp-empty">{err || '加载中…'}</div>
      </div>
    );
  }
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <Nav title="领队后台" onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 24 }}>
        <div className="tp-g4">
          <div><b>{d.rank ? `第 ${d.rank} 名` : '未上榜'}</b><span>领队排行榜</span></div>
          <div><b>{d.orders30}</b><span>近 30 天约单（人）</span></div>
          <div><b>{d.invited}</b><span>通过我注册（人）</span></div>
          <div><b>{d.rate}%</b><span>推荐奖励比例</span></div>
        </div>
        <div className="tp-wb" style={{ marginTop: 9 }}>
          <div className="tp-li" data-act="intro" onClick={() => setIntro(d.introPending ?? d.intro)}>
            <LeaderAvatar u={{ nickname: me?.nickname ?? '', avatar: me?.avatar ?? '' }} size={38} />
            <div className="hn-grow">
              <b>我的领队页</b>
              <div className="hn-t3 tp-ell" style={{ marginTop: 2 }}>{d.introPending !== null ? `新介绍审核中：${d.introPending || '（清空）'}` : d.intro || '还没写介绍'}</div>
            </div>
            <span className="end">编辑介绍 <Ic n="right" s={14} /></span>
          </div>
          <div className="tp-li" onClick={() => nav('/invite-card')}>
            <Ic n="link" s={18} style={{ color: 'var(--hn-rose)', width: 38 }} />
            <div className="hn-grow"><b>分享链接和海报</b><div className="hn-t3" style={{ marginTop: 2 }}>从这里注册的人，旅行页就是你</div></div>
            <span className="end">去分享 <Ic n="right" s={14} /></span>
          </div>
          <div className="tp-li" onClick={() => me && nav(`/trip/leader/${me.id}`)}>
            <Ic n="eye" s={18} style={{ color: 'var(--hn-rose)', width: 38 }} />
            <div className="hn-grow"><b>看看别人看到的领队页</b></div>
            <span className="end"><Ic n="right" s={14} /></span>
          </div>
        </div>
        <div className="tp-lab">我的线路<span className="hn-grow" /><span style={{ color: 'var(--hn-rose)', fontWeight: 700, cursor: 'pointer' }} data-act="publish" onClick={() => nav('/leader/publish')}>＋ 发布线路</span></div>
        {d.trips.length > 0 && (
          <div className="tp-wb">
            {d.trips.map((t) => (
              <div key={t.id} className="tp-li" data-mine={t.id} onClick={() => nav(`/leader/trip/${t.id}`)}>
                <Cover url={t.coverUrl} />
                <div className="hn-grow">
                  <b className="tp-ell" style={{ display: 'block' }}>{t.title}</b>
                  <div className="hn-t3 tp-ell" style={{ marginTop: 3 }}>
                    {t.state === 'rejected' ? t.rejectReason || '没通过，改了再提交'
                      : t.state === 'reviewing' ? `${tripDate(t.startDate)}出发 · 平台审核中`
                      : `${tripDate(t.startDate)}出发 · 约单 ${t.orders}${t.state === 'open' ? ` · 剩 ${t.left} 位` : ''}${t.hasPending ? ' · 改动审核中' : ''}`}
                  </div>
                </div>
                <TripState state={t.state} />
              </div>
            ))}
          </div>
        )}
        {d.trips.length === 0 && <div className="tp-empty" style={{ padding: '36px 30px' }}>还没有线路。点右上的「发布线路」，把带队视频发进来、说一句话就行。</div>}
        <div className="hn-t3" style={{ textAlign: 'center', marginTop: 16, lineHeight: 1.7, padding: '0 28px' }}>推荐奖励的钱等「结婚谢媒」上线后才会有，现在只显示比例。</div>
      </div>

      {intro !== null && (
        <div className="hn-dim center" onClick={() => setIntro(null)}>
          <div className="hn-dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>一句话介绍</div>
            <div className="hn-t2" style={{ marginTop: 4, fontSize: 12.5 }}>显示在你的领队页和排行榜上。改了以后平台看过才显示。</div>
            <textarea autoFocus maxLength={60} value={intro} placeholder="比如：坦克 300 车队，川西跑了 6 年（最多 60 个字）" style={{ marginTop: 12, minHeight: 96 }} onChange={(e) => setIntro(e.target.value)} />
            <div className="hn-row" style={{ marginTop: 14 }}>
              <button className="hn-btn flat" style={{ height: 44, fontSize: 14.5, flex: 1 }} onClick={() => setIntro(null)}>取消</button>
              <button className="hn-btn" style={{ height: 44, fontSize: 14.5, flex: 1 }} disabled={busy} onClick={saveIntro}>提交</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 管一条线路 */
export function LeaderTripPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const back = useBack();
  const [toast, showToast] = useToast();
  const { d, err, load } = useMine();
  const [confirm, setConfirm] = useState<{ title: string; body: string; ok: string; run: () => void } | null>(null);
  const [quota, setQuota] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = d?.trips.find((x) => x.id === id);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (done) showToast(done);
      await load();
    } catch (e: any) {
      showToast(e.message || '操作失败');
    }
    setBusy(false);
  };
  const setNum = (body: { quota?: number; confirmed?: number }) => act(() => api(`/trip/mine/${id}/quota`, { method: 'POST', body }));
  const enterGroup = () => act(async () => {
    const det = await api<TripDetail>(`/trip/detail/${id}`);
    if (det.group) openTripGroup(nav, det.group); else showToast('这条线路现在没有群');
  });

  if (!d || !t) {
    return (
      <div className="hn-page" style={{ background: '#fbf7f5' }}>
        <Nav title="线路" onBack={back} />
        <div className="tp-empty">{err || (d ? '没有这条线路' : '加载中…')}</div>
      </div>
    );
  }
  const listed = t.state === 'open' || t.state === 'departed' || t.state === 'ended';
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <Nav title={t.title.split(/[：:]/)[0]} onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 24 }}>
        <div className="tp-wb">
          <div className="tp-li" style={{ padding: '12px 13px', cursor: 'default' }}>
            <Cover url={t.coverUrl} style={{ width: 54, height: 54, borderRadius: 13 }} />
            <div className="hn-grow">
              <b style={{ fontSize: 14.5, lineHeight: 1.4, display: 'block' }}>{t.title}</b>
              <div className="hn-t3" style={{ marginTop: 4 }}>{tripDate(t.startDate)}出发 · {yuan(t.price)} / 人起</div>
            </div>
            <TripState state={t.state} />
          </div>
        </div>
        {t.state === 'rejected' && <div className="tp-box" style={{ background: '#fff5f4' }}><h5 style={{ color: '#d92d20' }}>没通过</h5><p>{why(t.rejectReason) || '平台没有写原因'}。改好以后点下面「改线路内容」再提交一次。</p></div>}
        {t.state === 'reviewing' && <div className="tp-box" style={{ background: '#fffaf0' }}><p>平台正在审核。通过以后才会出现在你的领队页上，同时自动建好这条线路的群。</p></div>}
        {t.hasPending && <div className="tp-box" style={{ background: '#fffaf0' }}><p>你改的内容正在审核。通过之前，别人看到的还是原来那一版。</p></div>}
        {listed && t.rejectReason && !t.hasPending && <div className="tp-box" style={{ background: '#fff5f4' }}><p>上次改的内容没通过：{why(t.rejectReason)}。线路照原来的样子在招募。</p></div>}

        {listed && (
          <>
            <div className="tp-lab">名额</div>
            <div className="tp-wb">
              <div className="tp-li" style={{ cursor: 'default' }}>
                <div className="hn-grow"><b>已经定下来的人数</b><div className="hn-t3" style={{ marginTop: 2 }}>总名额 {t.quota}，页面上显示「{t.left > 0 ? `还剩 ${t.left} 位` : '名额已满'}」</div></div>
                <div className="tp-stp">
                  <button data-act="minus" disabled={busy || t.confirmed <= 0} onClick={() => setNum({ confirmed: t.confirmed - 1 })}>−</button>
                  <b data-info="confirmed">{t.confirmed}</b>
                  <button data-act="plus" disabled={busy || t.confirmed >= t.quota} onClick={() => setNum({ confirmed: t.confirmed + 1 })}>＋</button>
                </div>
              </div>
              <div className="tp-li" data-act="orders" onClick={() => nav(`/leader/trip/${t.id}/orders`)}>
                <div className="hn-grow"><b>约单的人</b><div className="hn-t3" style={{ marginTop: 2 }}>{t.orders} 人约过单</div></div>
                <Chevron />
              </div>
            </div>
          </>
        )}

        <div className="tp-lab">这条线路</div>
        <div className="tp-wb">
          {listed && <div className="tp-li" data-act="group" onClick={enterGroup}><Ic n="chat" s={18} style={{ color: 'var(--hn-rose)' }} /><div className="hn-grow"><b>进线路群</b></div><Chevron /></div>}
          {listed && <div className="tp-li" data-act="quota" onClick={() => setQuota(String(t.quota))}><Ic n="users" s={18} style={{ color: 'var(--hn-rose)' }} /><div className="hn-grow"><b>改总名额</b></div><span className="end">{t.quota} 人 <Ic n="right" s={14} /></span></div>}
          {t.state !== 'off' && t.state !== 'departed' && t.state !== 'ended' && (
            <div className="tp-li" data-act="edit" onClick={() => nav(`/leader/publish?id=${t.id}`)}>
              <Ic n="pencil" s={18} style={{ color: 'var(--hn-rose)' }} />
              <div className="hn-grow"><b>改线路内容</b><div className="hn-t3" style={{ marginTop: 2 }}>视频、日期、价格、行程{t.state === 'open' ? '；改了要重新审核' : ''}</div></div>
              <Chevron />
            </div>
          )}
          <div className="tp-li" onClick={() => nav(`/trip/${t.id}`)}><Ic n="eye" s={18} style={{ color: 'var(--hn-rose)' }} /><div className="hn-grow"><b>看看用户看到的样子</b></div><Chevron /></div>
        </div>

        {(t.state === 'open' || t.state === 'reviewing' || t.state === 'rejected') && (
          <>
            <div
              className="tp-red" data-act="off"
              onClick={() => setConfirm(t.state === 'open'
                ? { title: '下架这条线路？', body: `下架后不再出现在列表里，线路群同时解散（之前的聊天记录还能看）。${t.orders > 0 ? `已经有 ${t.orders} 人约单。` : ''}下架了不能恢复，要重新发布。`, ok: '下架', run: () => void act(() => api(`/trip/mine/${t.id}/off`, { method: 'POST' }), '已下架') }
                : { title: '撤回这条线路？', body: '撤回以后不再审核。想发的话重新发布一条。', ok: '撤回', run: () => void act(() => api(`/trip/mine/${t.id}/off`, { method: 'POST' }), '已撤回') })}
            >
              {t.state === 'open' ? '下架这条线路' : '撤回这条线路'}
            </div>
            {t.state === 'open' && <div className="hn-t3" style={{ textAlign: 'center', marginTop: 10, lineHeight: 1.6, padding: '0 24px' }}>下架后不再出现在列表里，线路群同时解散（记录还能看）。</div>}
          </>
        )}
        {t.state === 'departed' && <div className="hn-t3" style={{ textAlign: 'center', marginTop: 16, lineHeight: 1.6, padding: '0 24px' }}>已经出发的线路不能下架、不能改，行程结束后自己变成「已结束」。</div>}
      </div>

      {confirm && <Confirm title={confirm.title} body={confirm.body} ok={confirm.ok} onOk={confirm.run} onClose={() => setConfirm(null)} />}
      {quota !== null && (
        <div className="hn-dim center" onClick={() => setQuota(null)}>
          <div className="hn-dialog" onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 16.5, fontWeight: 800 }}>改总名额</div>
            <div className="hn-t2" style={{ marginTop: 4, fontSize: 12.5 }}>1～200 人，不能比已经定下来的 {t.confirmed} 人少。改名额不用审核。</div>
            <div className="hn-field" style={{ marginTop: 12, boxShadow: 'none', background: '#faf6f6' }}>
              <input autoFocus inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value.replace(/\D/g, '').slice(0, 3))} />
            </div>
            <div className="hn-row" style={{ marginTop: 14 }}>
              <button className="hn-btn flat" style={{ height: 44, fontSize: 14.5, flex: 1 }} onClick={() => setQuota(null)}>取消</button>
              <button
                className="hn-btn" style={{ height: 44, fontSize: 14.5, flex: 1 }} disabled={busy || !quota || Number(quota) < Math.max(1, t.confirmed) || Number(quota) > 200}
                onClick={() => { const n = Number(quota); setQuota(null); void setNum({ quota: n }); }}
              >保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface OrderRow { id: string; nickname: string; avatar: string; gender: number; at: string; inGroup: boolean }

/** 约单的人 */
export function LeaderOrdersPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const back = useBack();
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<OrderRow[]>(`/trip/mine/${id}/orders`).then(setRows).catch((e: any) => setErr(e.message || '加载失败'));
  useEffect(() => { void load(); }, [id]);
  useTripLive(load, (e) => e.event === 'trip' && e.tripId === id);
  const when = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      <Nav title={rows ? `约单的人（${rows.length}）` : '约单的人'} onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 24 }}>
        {rows && rows.length > 0 && (
          <div className="tp-wb">
            {rows.map((r) => (
              <div key={r.id} className="tp-li" data-order={r.id} onClick={() => nav(`/u/${r.id}`)}>
                <div className="hn-meav" style={r.avatar ? { backgroundImage: `url(${r.avatar})` } : undefined} />
                <div className="hn-grow"><b>{r.nickname}</b><div className="hn-t3" style={{ marginTop: 2 }}>{when(r.at)} 约的{r.inGroup ? '' : ' · 现在不在群里了'}</div></div>
                <Chevron />
              </div>
            ))}
          </div>
        )}
        {rows && rows.length === 0 && <div className="tp-empty">还没有人约单。</div>}
        {!rows && <div className="tp-empty">{err || '加载中…'}</div>}
        <div className="hn-t3" style={{ textAlign: 'center', marginTop: 14, lineHeight: 1.7, padding: '0 28px' }}>点一个人看他的相亲画像。要把人移出，到线路群的群资料里操作。</div>
      </div>
    </div>
  );
}

// ---------- 发布 / 修改线路 ----------

/** 表里的各项（没填的是空字符串） */
interface Form { title: string; startDate: string; days: string; gatherPlace: string; price: string; quota: string; itinerary: string; feeNote: string }
const EMPTY: Form = { title: '', startDate: '', days: '', gatherPlace: '', price: '', quota: '', itinerary: '', feeNote: '' };
const KEYS = Object.keys(EMPTY) as (keyof Form)[];
/** AI 认出来的草稿 ↔ 表单 */
const toDraft = (f: Form) => Object.fromEntries(KEYS.map((k) => [k, f[k] === '' ? null : ['days', 'price', 'quota'].includes(k) ? Number(f[k]) : f[k]]));
const fromDraft = (d: Record<string, unknown>): Form => Object.fromEntries(KEYS.map((k) => [k, d?.[k] === null || d?.[k] === undefined ? '' : String(d[k])])) as unknown as Form;

const VIDEO_MAX = 100_000_000;
const VIDEO_MAX_SEC = 180;

/** 读视频多长、取第一帧当封面。读不出来（个别内嵌浏览器）时长当 0、封面是 null，照常能发 */
function probeVideo(file: File): Promise<{ sec: number; cover: Blob | null }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let done = false;
    const finish = (cover: Blob | null, why = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const sec = Number.isFinite(v.duration) ? v.duration : 0;
      // 没取到封面不拦着发，但留一句话在控制台（App 里会进日志），好查是哪一步没成
      if (!cover) console.warn(`trip: no cover from video (${why}), duration=${sec}, size=${v.videoWidth}x${v.videoHeight}`);
      try { v.pause(); } catch { /* 没在播 */ }
      URL.revokeObjectURL(url);
      resolve({ sec, cover });
    };
    const timer = setTimeout(() => finish(null, 'timeout'), 8000);
    const grab = () => {
      if (done) return;
      try {
        if (!v.videoWidth || !v.videoHeight) return finish(null, 'no frame size');
        const k = Math.min(1, 720 / v.videoWidth);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => finish(b, 'toBlob gave nothing'), 'image/jpeg', 0.82);
      } catch (e) {
        finish(null, `draw failed: ${e}`);
      }
    };
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.onerror = () => finish(null, `video error ${v.error?.code ?? ''} ${v.error?.message ?? ''}`);
    // 手机上的浏览器（包括 App 里的内嵌网页）不播放就不解码画面，等不到 loadeddata：知道时长以后静音播一下逼它解码，拿到画面就停
    v.onloadedmetadata = () => { v.play().catch(() => { /* 不让自动播的话，等 loadeddata 或者超时 */ }); };
    v.onloadeddata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch { grab(); } };
    v.onseeked = grab;
    v.src = url;
  });
}

type ChatItem = { who: 'me' | 'ai'; text: string } | { who: 'video' };

export function LeaderPublishPage() {
  const nav = useNavigate();
  const back = useBack();
  const me = useApp((s) => s.user);
  const [params] = useSearchParams();
  const editId = params.get('id') ?? '';
  const [toast, showToast] = useToast();
  /** 改已有的线路直接进表单；新发布默认和 AI 聊 */
  const [mode, setMode] = useState<'ai' | 'form'>(editId ? 'form' : 'ai');
  const [f, setF] = useState<Form>(EMPTY);
  const [video, setVideo] = useState<{ videoUrl: string; coverUrl: string }>({ videoUrl: '', coverUrl: '' });
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!editId);
  // 和 AI 聊
  const [chat, setChat] = useState<ChatItem[]>([{ who: 'ai', text: '把带队视频发进来（点左下角的加号），再用一句话说说这条线路：去哪、几天、哪天出发、多少钱、收几个人。' }]);
  const [said, setSaid] = useState('');
  const [thinking, setThinking] = useState(false);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [wallet, setWallet] = useState<{ start: number; now: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // 改已有的线路：把现在的内容填进表单
  useEffect(() => {
    if (!editId) return;
    api<TripDetail>(`/trip/detail/${editId}`).then((t) => {
      setF({ title: t.title, startDate: t.startDate, days: String(t.days), gatherPlace: t.gatherPlace, price: String(t.price), quota: String(t.quota), itinerary: t.itinerary, feeNote: t.feeNote });
      setVideo({ videoUrl: t.videoUrl, coverUrl: t.coverUrl });
      setLoaded(true);
    }).catch((e: any) => { showToast(e.message || '打不开这条线路'); setLoaded(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);
  const loadWallet = () => api<AiWalletView>('/ai-wallet').then((w) => setWallet((p) => ({ start: p?.start ?? w.balanceMicro, now: w.balanceMicro }))).catch(() => {});
  useEffect(() => { if (mode === 'ai') void loadWallet(); }, [mode]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat.length, thinking, missing]);

  const pickVideo = async (file: File | undefined) => {
    if (!file || progress !== null) return;
    if (!/^video\/(mp4|quicktime)$/.test(file.type)) return showToast('请选 MP4 或 MOV 格式的视频');
    if (file.size > VIDEO_MAX) return showToast('视频最大 100MB，选一个小一点的');
    setProgress(0);
    try {
      const { sec, cover } = await probeVideo(file);
      if (sec > VIDEO_MAX_SEC + 1) { setProgress(null); return showToast('视频最长 3 分钟，剪短一点再发'); }
      const videoUrl = await uploadBlob('video', file, file.name, (p) => setProgress(p));
      let coverUrl = '';
      if (cover) coverUrl = await uploadBlob('image', cover, 'cover.jpg').catch((e: any) => { console.warn(`trip: cover upload failed: ${e?.message}`); return ''; });
      setVideo({ videoUrl, coverUrl });
      if (mode === 'ai') setChat((c) => [...c.filter((x) => x.who !== 'video'), { who: 'video' }]);
    } catch (e: any) {
      showToast(e.message || '视频没传上去，再试一次');
    }
    setProgress(null);
  };

  /** AI 用不了（没牵豆也没 Key、Key 失效、模型服务不通）：改成自己填，已经认出来的带过去 */
  const fallToForm = (why: string) => { showToast(why); setMode('form'); };

  const say = async () => {
    const text = said.trim();
    if (!text || thinking) return;
    setSaid('');
    setChat((c) => [...c, { who: 'me', text }]);
    setThinking(true);
    try {
      const r = await api<{ draft: Record<string, unknown>; missing: string[]; reply: string }>('/trip/ai', { method: 'POST', body: { text, draft: toDraft(f) } });
      setF(fromDraft(r.draft));
      setMissing(r.missing);
      setChat((c) => [...c, { who: 'ai', text: r.missing.length === 0 && !video.videoUrl ? '各项都齐了，还差带队视频：点左下角的加号选一个。' : r.reply }]);
      void loadWallet();
    } catch (e: any) {
      const reason = reasonOf(e);
      if (reason === 'no_balance') fallToForm('牵豆不够了，改成自己填（不花牵豆）');
      else if (reason === 'need_key' || reason === 'key_invalid' || reason === 'key_no_balance') fallToForm('你的 Key 现在用不了，改成自己填');
      else if (reason === 'ai_down') fallToForm('AI 暂时没反应，改成自己填');
      else { setChat((c) => [...c, { who: 'ai', text: e.message || '我这边出了点问题，再说一次，或者点右上角「自己填」。' }]); }
    }
    setThinking(false);
  };

  const ready = KEYS.every((k) => f[k] !== '') && !!video.videoUrl;
  const submit = async () => {
    if (busy) return;
    if (!video.videoUrl) return showToast('先选带队视频');
    const lack = KEYS.find((k) => f[k].trim() === '');
    if (lack) return showToast(`还没填：${{ title: '标题', startDate: '出发日期', days: '天数', gatherPlace: '集合地', price: '价格', quota: '名额', itinerary: '行程', feeNote: '费用' }[lack]}`);
    setBusy(true);
    try {
      const body = { ...f, days: Number(f.days), price: Number(f.price), quota: Number(f.quota), ...video };
      const r = editId
        ? await api<{ pending: boolean }>(`/trip/mine/${editId}/update`, { method: 'POST', body })
        : await api<{ id: string }>('/trip/create', { method: 'POST', body });
      showToast((r as { pending?: boolean }).pending ? '已提交。审核通过之前，别人看到的还是原来那一版' : '已提交，平台审核通过后上架');
      setTimeout(() => nav('/leader', { replace: true }), 900);
    } catch (e: any) {
      showToast(e.message || '没提交成功');
      setBusy(false);
    }
  };

  const set = (k: keyof Form, v: string) => setF((p) => ({ ...p, [k]: v }));
  const tomorrow = new Date(Date.now() + 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
  const used = wallet ? Math.max(0, wallet.start - wallet.now) / 1_000_000 : 0;
  const fileInput = <input ref={fileRef} type="file" accept="video/mp4,video/quicktime" style={{ display: 'none' }} onChange={(e) => { void pickVideo(e.target.files?.[0]); e.target.value = ''; }} />;

  if (mode === 'ai') {
    return (
      <div className="hn-page">
        {toast}
        <Nav title="发布线路" badge="人工智能" onBack={back} right={<span className="tp-swt" data-act="to-form" onClick={() => setMode('form')}>自己填</span>} />
        <div className="hn-scroll hn-chat">
          {chat.map((m, i) => m.who === 'video' ? (
            <div key={i} className="hn-br me" style={{ marginBottom: 8 }}><Cover url={video.coverUrl} className="tp-vmsg"><span className="tp-play" style={{ width: 34, height: 34, top: '50%' }} /></Cover><div style={{ width: 38, flexShrink: 0 }} /></div>
          ) : m.who === 'me' ? (
            <div key={i} className="hn-br me"><div className="hn-bb me">{m.text}</div><div className="hn-meav" style={me?.avatar ? { backgroundImage: `url(${me.avatar})` } : undefined} /></div>
          ) : (
            <div key={i} className="hn-br"><Orb /><div className="hn-bb ai">{m.text}</div></div>
          ))}
          {thinking && <div className="hn-br"><Orb /><div className="hn-bb ai" style={{ color: 'var(--hn-ink3)' }}>正在认…</div></div>}
          {progress !== null && <div className="hn-t3" style={{ textAlign: 'center', marginBottom: 12 }}>视频上传中 {Math.round(progress * 100)}%</div>}
          {missing !== null && missing.length === 0 && video.videoUrl && !thinking && (
            <div className="hn-br"><Orb /><div className="tp-pv" data-info="preview">
              <div className="hn-row" style={{ gap: 9 }}><Cover url={video.coverUrl} style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0 }} /><b style={{ fontSize: 14, lineHeight: 1.4 }}>{f.title}</b></div>
              <div className="tp-kv"><span>出发</span>{tripDate(f.startDate)} · {f.days} 天 · {f.gatherPlace}集合</div>
              <div className="tp-kv"><span>价格</span>{yuan(Number(f.price))} / 人起 · 名额 {f.quota} 人</div>
              <div className="tp-kv"><span>行程</span>{f.itinerary}</div>
              <div className="tp-kv"><span>费用</span>{f.feeNote}</div>
              <div className="hn-t3" style={{ marginTop: 7, lineHeight: 1.5 }}>都对就点「提交审核」。要改直接跟我说，比如「价格改成 4200」。</div>
            </div></div>
          )}
          <div ref={endRef} />
        </div>
        <div className="hn-dock">
          {ready && missing !== null && missing.length === 0 && (
            <div className="hn-row" style={{ marginBottom: 2 }}>
              <button className="hn-btn ghost" style={{ flex: 1, height: 46, fontSize: 15 }} onClick={() => setMode('form')}>自己再改改</button>
              <button className="hn-btn" style={{ flex: 1.5, height: 46, fontSize: 15 }} data-act="submit" disabled={busy} onClick={submit}>提交审核</button>
            </div>
          )}
          <div className="hn-ibar">
            <button className="hn-send" style={{ background: '#fff', color: 'var(--hn-rose)', boxShadow: '0 4px 16px rgba(43,28,34,0.07)' }} disabled={progress !== null} data-act="pick-video" onClick={() => fileRef.current?.click()}><Ic n={video.videoUrl ? 'video' : 'plus'} s={20} /></button>
            <input value={said} placeholder="说说这条线路…" onChange={(e) => setSaid(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && say()} />
            <button className="hn-send" disabled={!said.trim() || thinking} data-act="say" onClick={say}><Ic n="up" s={20} /></button>
          </div>
          {wallet && <div className="hn-cost" onClick={() => nav('/ai-fee')}>这次 AI 用了 <b>{used < 0.01 && used > 0 ? '不到 0.01' : used.toFixed(2)} 牵豆</b> · 还剩 <b>{(wallet.now / 1_000_000).toFixed(2)}</b> <Ic n="right" s={12} /></div>}
        </div>
        {fileInput}
      </div>
    );
  }

  return (
    <div className="hn-page" style={{ background: '#fbf7f5' }}>
      {toast}
      <Nav title={editId ? '改线路内容' : '发布线路'} onBack={back} right={editId ? undefined : <span className="tp-swt" data-act="to-ai" onClick={() => setMode('ai')}>AI 帮我填</span>} />
      {!loaded ? <div className="tp-empty">加载中…</div> : (
        <>
          <div className="hn-scroll" style={{ paddingBottom: 16 }}>
            {video.videoUrl ? (
              <Cover url={video.coverUrl} className="tp-up shade"><span className="tp-play" style={{ width: 38, height: 38, top: '50%' }} /><span className="tip" onClick={() => fileRef.current?.click()}>带队视频 · 点了换一个</span>{progress !== null && <span className="tp-prog" style={{ width: `${progress * 100}%` }} />}</Cover>
            ) : (
              <div className="tp-up none" data-act="pick-video" onClick={() => fileRef.current?.click()}>
                <Ic n="video" s={22} />{progress !== null ? `上传中 ${Math.round(progress * 100)}%` : '选带队视频（MP4 / MOV，最长 3 分钟、最大 100MB）'}
                {progress !== null && <span className="tp-prog" style={{ width: `${progress * 100}%` }} />}
              </div>
            )}
            <div className="tp-fld"><span>标题</span><input data-f="title" maxLength={40} value={f.title} placeholder="去哪、几天，比如：川西环线 7 天" onChange={(e) => set('title', e.target.value)} /></div>
            <div className="tp-f2">
              <div className="tp-fld"><span style={{ width: 40 }}>出发</span><input data-f="startDate" type="date" min={tomorrow} value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
              <div className="tp-fld" style={{ flex: 0.62 }}><span style={{ width: 40 }}>天数</span><input data-f="days" inputMode="numeric" value={f.days} placeholder="7" onChange={(e) => set('days', e.target.value.replace(/\D/g, '').slice(0, 2))} /></div>
            </div>
            <div className="tp-fld"><span>集合地</span><input data-f="gatherPlace" maxLength={30} value={f.gatherPlace} placeholder="城市或具体地点" onChange={(e) => set('gatherPlace', e.target.value)} /></div>
            <div className="tp-f2">
              <div className="tp-fld"><span style={{ width: 40 }}>价格</span><input data-f="price" inputMode="numeric" value={f.price} placeholder="每人起价（元）" onChange={(e) => set('price', e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
              <div className="tp-fld" style={{ flex: 0.62 }}><span style={{ width: 40 }}>名额</span><input data-f="quota" inputMode="numeric" value={f.quota} placeholder="14" onChange={(e) => set('quota', e.target.value.replace(/\D/g, '').slice(0, 3))} /></div>
            </div>
            <div className="tp-fld ta"><span>行程</span><textarea data-f="itinerary" rows={4} maxLength={1000} value={f.itinerary} placeholder={'每天大概去哪，一段一行\n第 1 天 成都 → 康定\n第 2–3 天 稻城亚丁'} onChange={(e) => set('itinerary', e.target.value)} /></div>
            <div className="tp-fld ta"><span>费用</span><textarea data-f="feeNote" rows={3} maxLength={500} value={f.feeNote} placeholder="包含什么、不包含什么。比如：含车辆和住宿；不含餐费、门票" onChange={(e) => set('feeNote', e.target.value)} /></div>
            <div className="hn-t3" style={{ margin: '2px 28px 0', lineHeight: 1.6 }}>
              {editId ? '改了以后平台要重新审核；已经上架的线路，审核通过之前别人看到的还是原来那一版。' : '提交后平台审核，通过了才会出现在你的领队页上，同时自动建好这条线路的群。'}线路里不要留电话、微信、网址。
            </div>
          </div>
          <div className="hn-dock"><button className="hn-btn" style={{ width: '100%' }} data-act="submit" disabled={busy || progress !== null} onClick={submit}>{busy ? '正在提交…' : '提交审核'}</button></div>
        </>
      )}
      {fileInput}
    </div>
  );
}
