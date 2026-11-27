import { ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Ic, Orb } from '../hn';
import { MatchPerson, Quota, nextText, useLike } from '../match';

interface RecItem extends MatchPerson {
  /** AI 写的推荐理由；空 = 没写成（没有余额也没有 Key），只显示共同点 */
  reason: string;
  /** none 还没表态 | liked | passed | mutual */
  state: 'none' | 'liked' | 'passed' | 'mutual';
  likedMe: boolean;
}

interface Today {
  /** 我的基本情况填完了没有 */
  ready: boolean;
  nextAt: string;
  limit: number;
  quota: Quota;
  likedMe: number;
  list: RecItem[];
}

/**
 * 广场 → 遇见 → 推荐：每天挑几位（默认 3 位），一次看一位，喜欢或跳过后换下一位。
 * onBrowse：去旁边的「所有」逛逛。样稿：design/03-match.html 第 1、2 组
 */
export function RecSection({ onBrowse }: { onBrowse: () => void }) {
  const nav = useNavigate();
  const [d, setD] = useState<Today | null>(null);
  const [err, setErr] = useState('');
  const { like, busy, node, toast } = useLike();

  const load = () => api<Today>('/match/today').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  if (!d) return <div className="empty">{err || '正在为你挑人…'}</div>;

  const left = d.list.filter((x) => x.state === 'none');
  const cur = left[0];
  const setState = (id: string, state: RecItem['state']) => setD((v) => v && { ...v, list: v.list.map((x) => (x.user.id === id ? { ...x, state } : x)) });

  const onLike = async () => {
    if (!cur || busy) return;
    const r = await like(cur.user.id);
    if (r) setState(cur.user.id, r.matched ? 'mutual' : 'liked');
  };
  const onPass = async () => {
    if (!cur || busy) return;
    try {
      await api(`/match/pass/${cur.user.id}`, { method: 'POST' });
      setState(cur.user.id, 'passed');
    } catch (e) {
      toast((e as Error).message);
    }
  };

  /** 看完了 / 没有人 / 没填完时，下面那几行入口 */
  const links = (
    <div style={{ padding: '0 16px', marginTop: 26 }}>
      <div className="hn-glass" style={{ overflow: 'hidden' }}>
        <div className="hn-lr" onClick={() => nav('/likes?tab=likedMe')}>
          <span className="hn-sq" style={{ width: 30, height: 30, borderRadius: 10 }}><Ic n="heart" /></span>喜欢我的
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            {d.likedMe > 0 && <b style={{ color: 'var(--hn-rose)', fontSize: 15 }}>{d.likedMe} 人</b>}<Ic n="right" style={{ color: 'var(--hn-ink3)' }} />
          </span>
        </div>
        <div className="hn-lr" onClick={onBrowse}>
          <span className="hn-sq" style={{ width: 30, height: 30, borderRadius: 10 }}><Ic n="users" /></span>去「所有」里逛逛
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="hn-t2" style={{ fontSize: 12.5 }}>今天还能喜欢 {d.quota.left} 个</span><Ic n="right" style={{ color: 'var(--hn-ink3)' }} />
          </span>
        </div>
        <div className="hn-lr" onClick={() => nav('/deep')}>
          <span className="hn-sq" style={{ width: 30, height: 30, borderRadius: 10 }}><Ic n="spark" /></span>和 AI 红娘再聊聊，让推荐更准
          <Ic n="right" style={{ marginLeft: 'auto', color: 'var(--hn-ink3)' }} />
        </div>
      </div>
    </div>
  );

  const center = (title: string, sub: ReactNode, extra?: ReactNode) => (
    <div className="hn-recwrap">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '36px 30px 0', textAlign: 'center' }}>
        <Orb size="lg" />
        <div style={{ fontSize: 21, fontWeight: 800, marginTop: 28 }}>{title}</div>
        <div className="hn-t2" style={{ marginTop: 8, lineHeight: 1.7 }}>{sub}</div>
        {extra}
      </div>
      {d.ready && links}
      {node}
    </div>
  );

  // 基本情况没填完：不给推荐
  if (!d.ready) {
    return center('先把基本情况填完', '填完才能给你推荐，别人也才能在推荐里看到你。',
      <button className="hn-btn" style={{ marginTop: 22, width: 200 }} onClick={() => nav('/interview')}>去填写</button>);
  }
  // 现在一个条件对得上的人都没有：如实说
  if (d.list.length === 0) {
    return center('现在还没有合适的人', <>条件和你互相符合的人暂时还没有。<br />有新的人加入，会第一时间推荐给你。</>);
  }
  if (!cur) {
    const liked = d.list.filter((x) => x.state === 'liked' || x.state === 'mutual').length;
    const passed = d.list.filter((x) => x.state === 'passed').length;
    return center(`今天的 ${d.list.length} 位看完了`, <>{nextText(d.nextAt)}有新的推荐<br />今天喜欢了 {liked} 位，跳过 {passed} 位</>);
  }

  const ta = cur.user.gender === 1 ? '他' : '她';
  return (
    <div className="hn-recwrap">
      <div className="hn-row" style={{ padding: '2px 22px 8px' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>
          今天为你挑了 {d.list.length} 位
          {d.list.length < d.limit && <span className="hn-t3" style={{ marginLeft: 6, fontWeight: 400 }}>合适的人还不多，有几位给几位</span>}
        </span>
        <span className="hn-pg" style={{ marginLeft: 'auto' }}>{d.list.map((x) => <i key={x.user.id} className={x.user.id === cur.user.id ? 'on' : ''} />)}</span>
      </div>

      <div className="hn-rec">
        <div className="ph" style={cur.user.avatar ? { backgroundImage: `url(${cur.user.avatar})` } : undefined} onClick={() => nav(`/u/${cur.user.id}`)}>
          <div className="txt">
            <div style={{ fontSize: 25, fontWeight: 800 }}>{cur.user.nickname} {!!cur.user.age && <span style={{ fontWeight: 500, fontSize: 20 }}>{cur.user.age}</span>}</div>
            <div className="hn-row" style={{ gap: 5, marginTop: 7, flexWrap: 'wrap' }}>{cur.chips.map((c) => <span key={c} className="hn-chipg">{c}</span>)}</div>
          </div>
        </div>
        <div className="why">
          <div className="hn-lbl">
            <Orb size="sm" />{cur.reason ? `AI 红娘为什么推荐${ta}` : `你和${ta}的共同点`}
            {cur.reason && <span className="r"><Ic n="spark" s={10} />AI 生成</span>}
          </div>
          {cur.reason && <div style={{ fontSize: 14.5, lineHeight: 1.65, marginTop: 8 }}>{cur.reason}</div>}
          {cur.tags.length > 0
            ? <div className="hn-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>{cur.tags.map((t) => <span key={t} className="hn-tag">{t}</span>)}</div>
            : !cur.reason && <div className="hn-t2" style={{ marginTop: 8, lineHeight: 1.6 }}>你们的条件互相符合。点照片看{ta}的完整画像。</div>}
          {cur.likedMe && <div className="hn-t2" style={{ marginTop: 10, color: 'var(--hn-rose)', fontWeight: 600 }}>{ta}已经喜欢了你，你也喜欢的话就可以视频见面</div>}
        </div>
      </div>
      {left.length > 1 && <div className="hn-under" />}
      {left.length > 2 && <div className="hn-under b" />}

      <div className="hn-acts">
        <button className="hn-rb" disabled={busy} onClick={onPass}><Ic n="x" s={26} /></button>
        <button className="hn-rb like" disabled={busy} onClick={onLike}><Ic n="heart" s={30} /></button>
      </div>
      <div className="hn-t3" style={{ textAlign: 'center', marginTop: 8 }}>点照片看{ta}的完整画像</div>
      {node}
    </div>
  );
}
