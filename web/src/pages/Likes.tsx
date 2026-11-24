import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Ic, Nav, useBack } from '../hn';
import { MatchPerson, MatchSummary, agoText, openChatWith, useLike } from '../match';

type Tab = 'likedMe' | 'liked' | 'mutual';
interface Row extends MatchPerson {
  at: string | null;
  isNew: boolean;
  conversationId: string | null;
}

const TABS: [Tab, string][] = [['likedMe', '喜欢我的'], ['liked', '我喜欢的'], ['mutual', '互相喜欢']];
const EMPTY: Record<Tab, string> = {
  likedMe: '还没有人喜欢你。把画像填得更完整一些，更容易被看到。',
  liked: '你还没有喜欢的人，或者对方都已经回应了。',
  mutual: '还没有互相喜欢的人。',
};

/**
 * 喜欢列表：喜欢我的 / 我喜欢的 / 互相喜欢。从消息页顶上的三个数字进来（/likes?tab=likedMe）。
 * App 里也是这个网页（原生消息页的入口用内嵌网页打开它）。样稿：design/03-match.html 第 2 组
 */
export function LikesPage() {
  const nav = useNavigate();
  const back = useBack();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find(([k]) => k === params.get('tab'))?.[0] ?? 'likedMe') as Tab;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sum, setSum] = useState<MatchSummary | null>(null);
  const [err, setErr] = useState('');
  const { like, busy, node, toast } = useLike();

  const load = () => {
    api<{ list: Row[] }>(`/match/list?tab=${tab}`).then((r) => setRows(r.list)).catch((e) => setErr(e.message));
    api<MatchSummary>('/match/summary').then(setSum).catch(() => {});
  };
  useEffect(() => {
    setRows(null);
    setErr('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const drop = (id: string) => setRows((list) => list?.filter((r) => r.user.id !== id) ?? null);
  const likeBack = async (r: Row) => {
    const res = await like(r.user.id);
    if (res) { drop(r.user.id); load(); }
  };
  const act = async (path: string, r: Row, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    try {
      await api(`/match/${path}/${r.user.id}`, { method: 'POST' });
      drop(r.user.id);
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const who = (r: Row) => (r.user.gender === 1 ? '他' : '她');
  const count: Record<Tab, number | undefined> = { likedMe: sum?.likedMe, liked: sum?.liked, mutual: sum?.mutual };

  return (
    <div className="hn-page">
      <Nav title="喜欢" onBack={back} />
      <div className="hn-seg">
        {TABS.map(([k, label]) => (
          <span key={k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k }, { replace: true })}>
            {label}{k === 'likedMe' && !!count[k] ? <b>{count[k]}</b> : count[k] ? ` ${count[k]}` : ''}
          </span>
        ))}
      </div>
      <div className="hn-scroll" style={{ paddingTop: 14, paddingBottom: 24 }}>
        {rows === null && <div className="hn-t2" style={{ textAlign: 'center', padding: 50 }}>{err || '加载中…'}</div>}
        {rows?.length === 0 && <div className="hn-t2" style={{ textAlign: 'center', padding: '50px 40px', lineHeight: 1.7 }}>{EMPTY[tab]}</div>}
        {rows?.map((r) => (
          <div key={r.user.id} className="hn-pr hn-glass">
            <div className="av" style={r.user.avatar ? { backgroundImage: `url(${r.user.avatar})` } : undefined} onClick={() => nav(`/u/${r.user.id}`)} />
            <div className="hn-grow" onClick={() => nav(`/u/${r.user.id}`)} style={{ cursor: 'pointer' }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {r.user.nickname} {!!r.user.age && <span style={{ fontWeight: 500 }}>{r.user.age}</span>}
                {r.isNew && <span className="hn-new">新</span>}
              </div>
              <div className="hn-t3" style={{ marginTop: 3, lineHeight: 1.5 }}>
                {[...r.chips.filter((c) => !c.endsWith('cm')).slice(0, 3), r.at && (tab === 'likedMe' ? `${agoText(r.at)}喜欢了你` : tab === 'liked' ? `${agoText(r.at)}喜欢的` : `${agoText(r.at)}配上`)].filter(Boolean).join(' · ')}
              </div>
              {r.tags.length > 0 && (
                <div className="hn-row" style={{ gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                  {r.tags.map((t) => <span key={t} className="hn-tag" style={{ height: 22, fontSize: 11 }}>{t}</span>)}
                </div>
              )}
            </div>
            {tab === 'likedMe' && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <button className="hn-pill" style={{ height: 38, borderRadius: 19 }} disabled={busy} onClick={() => likeBack(r)}><Ic n="heart" s={14} />也喜欢</button>
                <span className="hn-t3" style={{ cursor: 'pointer', padding: '2px 6px', fontSize: 12 }} onClick={() => act('pass', r, `不想认识${who(r)}？${who(r)}不会收到通知，以后也不再互相推荐。`)}>不合适</span>
              </div>
            )}
            {tab === 'liked' && (
              <button className="hn-pill ghost" style={{ height: 36, borderRadius: 18 }} onClick={() => act('unlike', r, `取消喜欢${r.user.nickname}？今天用掉的名额不会退回。`)}>取消喜欢</button>
            )}
            {tab === 'mutual' && (
              <button className="hn-pill" style={{ height: 38, borderRadius: 19 }} onClick={() => openChatWith(nav, r.user).catch((e) => toast((e as Error).message))}><Ic n="chat" s={14} />发消息</button>
            )}
          </div>
        ))}
        {!!rows?.length && (
          <div className="hn-t3" style={{ textAlign: 'center', marginTop: 8, lineHeight: 1.7 }}>
            点头像看完整画像{tab === 'likedMe' ? ' · 点「不合适」对方不会收到通知' : tab === 'liked' ? ' · 对方回应后会出现在「互相喜欢」里' : ''}
          </div>
        )}
      </div>
      {node}
    </div>
  );
}
