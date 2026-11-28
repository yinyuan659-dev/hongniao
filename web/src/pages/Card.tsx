import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { hnNative } from '../bridge';
import { CardChip, CardData, Ic, Orb, useBack, useToast } from '../hn';
import { CardMatch, ReportSheet, openChatWith, useLike } from '../match';

/** 基本情况里每一项前面的小图标 */
const FACT_ICON: Record<string, string> = {
  birthYear: 'cake', height: 'ruler', city: 'pin', hometown: 'home', education: 'cap', job: 'bag', marital: 'heart',
  house: 'home', car: 'car', wantKids: 'baby', marryPlan: 'clock', smoke: 'leaf', drink: 'cup',
};

const DEEP_BTN: Record<string, string> = { none: '和 AI 红娘深聊', chatting: '继续和 AI 聊', draft: '去确认画像', done: '再和 AI 聊聊' };

/**
 * 相亲画像网页：头像、昵称、照片、点选问答的每一项、AI 整理的画像都在这一页。
 * /card/me 是看自己（能改、能看到私密内容）；/card/:id、/u/:id 是看别人（只有公开的部分）。
 * 修改还是老办法：点一项 → 回到聊天页让 AI 红娘重新问那一题。样稿：design/01-ai-interview.html 第 3、4 组
 */
export function CardPage() {
  const nav = useNavigate();
  const { id = 'me' } = useParams<{ id: string }>();
  const [c, setC] = useState<CardData | null>(null);
  const [err, setErr] = useState('');
  const [idx, setIdx] = useState(0);
  const [viewer, setViewer] = useState('');
  /** 正在改 AI 画像里的哪一项 */
  const [editing, setEditing] = useState<{ key: string; label: string; value: string } | null>(null);
  const [menu, setMenu] = useState(false);
  const [reporting, setReporting] = useState(false);
  const { like, busy, node: likeNode } = useLike();
  const [toast, showToast] = useToast();
  const slides = useRef<HTMLDivElement>(null);
  const back = useBack();
  // 下面几个动作：在 App 的内嵌网页里交给原生页面，在浏览器里走网页自己的页面
  const goEdit = () => { if (!hnNative('editProfile')) nav('/edit-profile'); };
  const goDeep = () => { if (!hnNative('deep')) nav('/deep'); };

  const load = () => {
    api<CardData>(`/hn/card/${id}`).then(setC).catch((e) => setErr(e.message));
  };
  useEffect(load, [id]);

  if (!c) {
    return (
      <div className="hn-page">
        <div className="hn-nav"><button className="hn-icbtn" onClick={back}><Ic n="left" /></button></div>
        <div className="hn-t2" style={{ textAlign: 'center', padding: 60 }}>{err || '加载中…'}</div>
      </div>
    );
  }

  /** 能改：自己看自己 */
  const edit = c.self;
  const who = c.self ? '我' : c.user.gender === 1 ? '他' : '她';
  /** 点一项 → 回聊天页重新回答那一题 */
  const reask = (key: string) => { if (!hnNative('interview', { edit: key })) nav(key ? `/interview?edit=${key}` : '/interview'); };
  const chips = (list: CardChip[]) => list.filter((x) => edit || !x.empty);

  const saveEdit = async (value: string) => {
    if (!editing) return;
    try {
      await api('/hn/deep/portrait', { method: 'POST', body: { key: editing.key, value } });
      setEditing(null);
      load();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const openChat = () => openChatWith(nav, c.user).catch((e) => showToast((e as Error).message));

  /** 我和 TA 的关系（看自己时是 null） */
  const m = c.match;
  const setMatch = (patch: Partial<CardMatch>) => setC((v) => (v && v.match ? { ...v, match: { ...v.match, ...patch } } : v));

  const onLike = async () => {
    const r = await like(c.user.id);
    if (r) setMatch({ state: r.state, passed: false, quota: r.quota, ...(r.matched ? { chatReason: 'mutual', canVideo: true, videoReason: 'ok' } : {}) });
  };
  /** 跳过 / 不合适：对方不知道。点完回到上一页（从推荐页进来的，回去就是下一位） */
  const onPass = async () => {
    if (m?.state === 'likedMe' && !window.confirm(`不想认识${who}？${who}不会收到通知，以后也不再互相推荐。`)) return;
    try {
      await api(`/match/pass/${c.user.id}`, { method: 'POST' });
      back();
    } catch (e) {
      showToast((e as Error).message);
    }
  };
  const onUnlike = async () => {
    if (!window.confirm(`取消喜欢${c.user.nickname}？今天用掉的名额不会退回。`)) return;
    try {
      await api(`/match/unlike/${c.user.id}`, { method: 'POST' });
      setMatch({ state: 'none' });
    } catch (e) {
      showToast((e as Error).message);
    }
  };
  const onEnd = async () => {
    if (!window.confirm(`确定不再和${c.user.nickname}联系？\n之后你们都不能再给对方发消息，也不再互相推荐。${who}只会看到「对方已结束聊天」。`)) return;
    try {
      await api(`/match/end/${c.user.id}`, { method: 'POST' });
      setMatch({ state: 'ended', endedBy: 'me', canChat: false });
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const wall = c.photos.slice(1, 4);

  return (
    <div className="hn-page" style={{ background: 'var(--hn-cream)' }}>
      <div className="hn-scroll">
        {/* 整屏大照片：头像 + 照片墙左右滑 */}
        <div className="hn-hero">
          <div
            className="slides" ref={slides}
            onScroll={(e) => setIdx(Math.round(e.currentTarget.scrollLeft / Math.max(e.currentTarget.clientWidth, 1)))}
          >
            {(c.photos.length ? c.photos : ['']).map((url, i) => <div key={i} style={url ? { backgroundImage: `url(${url})` } : undefined} />)}
          </div>
          <div className="shade" />
          <div className="top">
            <span className="hn-gbtn" onClick={back}><Ic n="left" s={18} /></span>
            {edit && <span className="hn-gbtn" onClick={() => goEdit()}><Ic n="camera" s={15} />换头像 / 照片</span>}
            {!c.self && <span className="hn-gbtn" onClick={() => setMenu(true)}><Ic n="more" s={18} /></span>}
          </div>
          <div className="info">
            {c.photos.length > 1 && <div className="hn-bars">{c.photos.map((_, i) => <i key={i} className={i === idx ? 'on' : ''} />)}</div>}
            {/* 名字这一行：窄屏上放不下时整个元素换到下一行，标签和按钮里的字不折行；昵称太长才省略 */}
            <div className="hn-row" style={{ alignItems: 'baseline', gap: '6px 10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 32, fontWeight: 800, letterSpacing: 0.5, maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.user.nickname}</span>
              {c.user.age > 0 && <span style={{ fontSize: 24, fontWeight: 500, flexShrink: 0 }}>{c.user.age}</span>}
              {c.realname && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 700, color: '#fff', background: 'linear-gradient(135deg,#12b76a,#22c55e)', boxShadow: '0 4px 10px rgba(18,183,106,.3)', alignSelf: 'center', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  <Ic n="shield" s={13} />真人认证
                </span>
              )}
              {/* 自己的画像、还没做真人认证：原来这里什么都没有，找不到去认证的地方（2026-11-28 用户反馈）。点了去认证，认证完回到这一页 */}
              {c.self && !c.realname && (
                <span
                  role="button" data-act="go-kyc" onClick={() => nav(`/kyc?next=${encodeURIComponent('/card/me')}`)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 10px', borderRadius: 12, fontSize: 11.5, fontWeight: 700, color: '#fff', background: 'rgba(255,255,255,.22)', border: '1px solid rgba(255,255,255,.55)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', alignSelf: 'center', whiteSpace: 'nowrap', flexShrink: 0, cursor: 'pointer' }}
                >
                  <Ic n="shield" s={13} />去真人认证 ›
                </span>
              )}
              {/* 改昵称：只留一个铅笔图标，窄屏上能和昵称、年龄、标排在同一行 */}
              {edit && <span className="hn-gbtn" role="button" aria-label="改昵称" title="改昵称" style={{ height: 28, width: 28, minWidth: 0, padding: 0, marginLeft: 'auto', alignSelf: 'center', flexShrink: 0 }} onClick={() => goEdit()}><Ic n="pencil" s={13} /></span>}
            </div>
            <div className="hn-row" style={{ gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              {c.hero.map((h, i) => <span key={h} className="hn-chipg">{i === 0 && <Ic n="pin" s={12} style={{ marginRight: 4 }} />}{h}</span>)}
            </div>
          </div>
        </div>

        <div className="hn-wsheet">
          {/* 每日推荐里出现过的人：最上面多一块「为什么推荐给你」。AI 没写成（没有余额也没有 Key）就只有共同点 */}
          {m?.recommended && (m.reason || m.tags.length > 0) && (
            <div className="hn-wcard" style={{ background: 'linear-gradient(135deg,#fff0f2,#fff6ec)', border: '1px solid #fff', boxShadow: '0 8px 26px rgba(255,90,120,.10)' }}>
              <div className="hn-lbl"><Orb size="sm" />为什么推荐给你{m.reason && <span className="r"><Ic n="spark" s={10} />AI 生成</span>}</div>
              {m.reason && <div style={{ fontSize: 14.5, lineHeight: 1.65, marginTop: 8 }}>{m.reason}</div>}
              {m.tags.length > 0 && <div className="hn-row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 10 }}>{m.tags.map((t) => <span key={t} className="hn-tag">{t}</span>)}</div>}
            </div>
          )}
          {/* AI 那段话：深聊过是 AI 写的；没深聊过是点选问答自动拼的 */}
          {c.ai ? (
            <div className="hn-wcard hn-glass">
              <div className="hn-lbl">
                <Orb size="sm" />{c.ai.byAi ? `AI 红娘眼里的${who}` : '红娘整理的介绍'}
                {c.ai.byAi && <span className="r">{c.ai.draft ? '还没确认 · ' : ''}<Ic n="spark" s={10} />AI 生成</span>}
              </div>
              <div
                className="hn-quote" style={c.ai.byAi ? undefined : { fontSize: 16, fontWeight: 600 }}
                onClick={() => edit && c.ai!.byAi && setEditing({ key: 'summary', label: '一句话介绍', value: c.ai!.summary })}
              >{c.ai.summary || (edit ? '还没有内容' : '')}</div>
              <div className="hn-row" style={{ flexWrap: 'wrap', gap: 7, marginTop: 12 }}>
                {c.ai.tags.map((t) => <span key={t} className="hn-tag">{t}</span>)}
              </div>
              {edit && !c.ai.byAi && c.profileDone && (
                <button className="hn-pill" style={{ marginTop: 14, height: 38, borderRadius: 19 }} onClick={() => goDeep()}><Ic n="spark" s={14} />和 AI 红娘聊聊，让画像更像你</button>
              )}
            </div>
          ) : (
            <div className="hn-wcard hn-glass hn-t2" style={{ lineHeight: 1.7 }}>{who === '我' ? '资料还没填完。' : `${who}还没有完成资料收集。`}</div>
          )}

          {edit && !c.profileDone && (
            <button className="hn-btn" style={{ marginBottom: 14 }} onClick={() => reask('')}>继续填基本情况</button>
          )}

          {(c.intro || edit) && c.ai && (
            <div className="hn-wcard hn-glass">
              <div className="hn-lbl" style={{ color: 'var(--hn-ink2)' }}>{who}自己说{edit && <span className="hn-edit" onClick={() => reask('intro')}><Ic n="pencil" s={11} />改</span>}</div>
              <div style={{ fontSize: 16, lineHeight: 1.7, marginTop: 8, fontWeight: 500, color: c.intro ? undefined : 'var(--hn-ink3)' }}>{c.intro || '还没写。写一两句话介绍自己，对方能看到。'}</div>
            </div>
          )}

          {/* 照片墙：除了第一张（已经在顶上）以外的几张 */}
          {wall.length === 0 && edit && (
            <div className="hn-addph" style={{ height: 62, marginBottom: 16 }} onClick={() => goEdit()}><Ic n="plus" s={15} />加几张生活照，对方更容易了解你</div>
          )}
          {wall.length > 0 && (
            <div className="hn-mosaic">
              {wall[0] && <div className="ph" style={{ flex: 1.25, backgroundImage: `url(${wall[0]})` }} onClick={() => setViewer(wall[0])} />}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {wall[1] && <div className="ph" style={{ flex: 1, backgroundImage: `url(${wall[1]})` }} onClick={() => setViewer(wall[1])} />}
                {wall[2] && !edit && <div className="ph" style={{ flex: 1, backgroundImage: `url(${wall[2]})` }} onClick={() => setViewer(wall[2])} />}
                {edit && <div className="hn-addph" style={{ flex: wall[1] ? '0 0 62px' : 1 }} onClick={() => goEdit()}><Ic n="plus" s={15} />加照片</div>}
              </div>
            </div>
          )}

          {chips(c.facts).length > 0 && (
            <>
              <div className="hn-sec">基本情况{edit && <span className="hn-edit" style={{ cursor: 'default' }}><Ic n="pencil" s={11} />点一项可改</span>}</div>
              <div className="hn-facts" style={{ marginBottom: 18 }}>
                {chips(c.facts).map((f) => (
                  <span key={f.key} className={`hn-fact${edit ? ' tap' : ''}${f.empty ? ' empty' : ''}`} onClick={() => edit && reask(f.key)}>
                    {f.empty ? <Ic n="plus" s={13} /> : FACT_ICON[f.key] && <Ic n={FACT_ICON[f.key]} />}{f.text}
                  </span>
                ))}
              </div>
            </>
          )}

          {(c.hobbies.length > 0 || (edit && c.ai)) && (
            <>
              <div className="hn-sec">平时喜欢</div>
              <div className="hn-facts" style={{ marginBottom: 18 }}>
                {c.hobbies.map((h) => <span key={h} className={`hn-fact${edit ? ' tap' : ''}`} onClick={() => edit && reask('hobbies')}>{h}</span>)}
                {c.hobbies.length === 0 && <span className="hn-fact tap empty" onClick={() => reask('hobbies')}><Ic n="plus" s={13} />兴趣爱好</span>}
              </div>
            </>
          )}

          {(c.partner || chips(c.prefs).length > 0) && (
            <div className="hn-wcard" style={{ background: 'linear-gradient(135deg,#fff0f2,#fff6ec)', border: '1px solid #fff', boxShadow: '0 8px 26px rgba(255,90,120,.10)' }}>
              <div className="hn-sec" style={{ marginTop: 0 }}>
                <Ic n="heart" s={17} style={{ color: 'var(--hn-rose)', marginRight: 6 }} />想找的人
                {edit && <span className="hn-edit" style={{ cursor: 'default' }}><Ic n="pencil" s={11} />点一项可改</span>}
              </div>
              {c.partner && (
                <div
                  style={{ fontSize: 16, lineHeight: 1.65, fontWeight: 700, marginTop: 10 }}
                  onClick={() => edit && setEditing({ key: 'partner', label: '想找的人', value: c.partner })}
                >{c.partner}</div>
              )}
              <div className="hn-facts">
                {chips(c.prefs).map((f) => (
                  <span key={f.key} className={`hn-fact${edit ? ' tap' : ''}${f.empty ? ' empty' : ''}`} onClick={() => edit && reask(f.key)}>{f.empty && <Ic n="plus" s={13} />}{f.text}</span>
                ))}
              </div>
            </div>
          )}

          {/* 彩礼、要孩子的前提这些都写在上面「想找的人」里了，这里提醒一句：平台不经手，别提前转账 */}
          {chips(c.prefs).some((f) => f.key.startsWith('bride') || f.key === 'kidsBefore') && (
            <div className="hn-t3" style={{ margin: '-4px 6px 14px', lineHeight: 1.7, fontSize: 11.5 }}>
              彩礼是两家人之间的事，平台不经手。领证之前不要转账；谈好的金额和给法，最好写下来、双方签字。
            </div>
          )}

          {/* AI 深聊整理的每一行：别人看到的和自己看到的一样 */}
          {c.rows.length > 0 && (
            <div className="hn-wcard hn-glass">
              <div className="hn-sec" style={{ fontSize: 15, marginTop: 0 }}>
                <Orb size="sm" /><span style={{ marginLeft: 6 }}>聊天里了解到的</span>
                {edit && <span className="hn-edit" style={{ cursor: 'default' }}><Ic n="pencil" s={11} />点一项可改</span>}
              </div>
              {c.rows.map((r) => (
                <div
                  key={r.key} style={{ display: 'flex', gap: 10, padding: '10px 0 0', fontSize: 14, lineHeight: 1.6, cursor: edit ? 'pointer' : 'default' }}
                  onClick={() => edit && setEditing({ key: r.key, label: r.label, value: r.text })}
                >
                  <span style={{ width: 62, flexShrink: 0, color: 'var(--hn-ink2)' }}>{r.label}</span>
                  <span style={{ flex: 1 }}>{r.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* 需要注意的事：AI 在深聊里听到本人自己说的严重问题。本人改不了，谁看都有 */}
          {c.flags.length > 0 && (
            <div className="hn-wcard" style={{ background: '#fff6e5', border: '1px solid #ffdf9e' }}>
              <div className="hn-sec" style={{ fontSize: 15, marginTop: 0, color: '#9a5b00' }}><Ic n="info" s={17} style={{ marginRight: 6 }} />需要注意</div>
              {c.flags.map((f) => <div key={f} style={{ fontSize: 14.5, lineHeight: 1.65, marginTop: 8, fontWeight: 600 }}>· {f}</div>)}
              <div className="hn-t3" style={{ marginTop: 10, lineHeight: 1.7, color: '#b98a3a', fontSize: 11.5 }}>
                {c.self
                  ? '这是 AI 红娘根据你在深聊里说的话记下的，对方在你的画像里能看到，你自己不能修改。如果记错了，请联系平台核实更正。'
                  : `这是 AI 红娘根据${who}本人在深聊里说的话记下的，${who}自己不能修改。`}
              </div>
            </div>
          )}

          {!c.self && (
            <div className="hn-glass hn-lr" style={{ borderRadius: 18, marginBottom: 14 }} onClick={() => { if (!hnNative('userHome', { id: c.user.id })) nav(`/u/${c.user.id}/home`); }}>
              <span className="hn-sq" style={{ width: 30, height: 30, borderRadius: 10 }}><Ic n="image" /></span>看{who}的动态<Ic n="right" style={{ marginLeft: 'auto', color: 'var(--hn-ink3)' }} />
            </div>
          )}
          <div className="hn-t3" style={{ textAlign: 'center', marginTop: 4 }}>由 AI 红娘（人工智能）整理 · 内容经本人确认</div>
        </div>
      </div>

      {/* 底部按钮 */}
      {c.self ? (
        // 别人看到的和自己看到的是同一页（只是没有修改按钮），所以不需要「别人看到的样子」了
        c.profileDone && (
          <div className="hn-wdock hn-glass">
            <button className="hn-btn" style={{ flex: 1 }} onClick={() => goDeep()}><Ic n="spark" s={16} />{DEEP_BTN[c.deepStatus ?? 'none']}</button>
          </div>
        )
      ) : m && (
        // 看别人：按两个人的关系显示五种样子里的一种（样稿 design/09-openchat.html 第 1 组）。
        // 2026-11-27 起发消息放开了：没结束联系的四种里都有「发消息」；喜欢还是原来的规矩，互相喜欢后可以视频见面。
        <div style={{ position: 'absolute', left: 14, right: 14, bottom: 'calc(16px + env(safe-area-inset-bottom))', zIndex: 20 }}>
          {m.state === 'liked' && <div className="hn-tip" style={{ margin: '0 0 8px' }}>你已经喜欢了{who}，等{who}回应。可以先聊聊</div>}
          {m.state === 'likedMe' && <div className="hn-tip rose" style={{ margin: '0 0 8px' }}>{who}喜欢了你。你也喜欢的话，就可以视频见面</div>}
          {m.state === 'ended' && <div className="hn-tip" style={{ margin: 0, padding: '14px' }}>{m.endedBy === 'me' ? '你已选择不再联系' : '对方已结束聊天'}</div>}
          {m.state !== 'ended' && (
            <div className="hn-wdock hn-glass" style={{ position: 'static', gap: 8 }}>
              {m.state === 'none' && (
                <>
                  <button className="hn-btn" style={ghostBtn} disabled={busy} onClick={onPass}><Ic n="x" s={17} />跳过</button>
                  <button className="hn-btn line" style={{ flex: 1.3 }} onClick={openChat}><Ic n="chat" s={16} />发消息</button>
                  <button className="hn-btn" style={{ flex: 1.5 }} disabled={busy} onClick={onLike}><Ic n="heart" s={17} />喜欢</button>
                </>
              )}
              {m.state === 'liked' && (
                <>
                  <button className="hn-btn" style={{ ...ghostBtn, fontSize: 14 }} disabled={busy} onClick={onUnlike}>取消喜欢</button>
                  <button className="hn-btn" style={{ flex: 1.6 }} onClick={openChat}><Ic n="chat" s={17} />发消息</button>
                </>
              )}
              {m.state === 'likedMe' && (
                <>
                  <button className="hn-btn" style={{ ...ghostBtn, fontSize: 14 }} disabled={busy} onClick={onPass}>不合适</button>
                  <button className="hn-btn line" style={{ flex: 1.3 }} onClick={openChat}><Ic n="chat" s={16} />发消息</button>
                  <button className="hn-btn" style={{ flex: 1.5 }} disabled={busy} onClick={onLike}><Ic n="heart" s={17} />也喜欢</button>
                </>
              )}
              {m.state === 'mutual' && <button className="hn-btn" style={{ flex: 1 }} onClick={openChat}><Ic n="chat" s={17} />发消息</button>}
            </div>
          )}
        </div>
      )}

      {/* 右上角「···」：举报、不合适 */}
      {menu && m && (
        <>
          <div className="hn-menu-mask" onClick={() => setMenu(false)} />
          <div className="hn-menu" style={{ top: 'calc(54px + env(safe-area-inset-top))' }}>
            <div onClick={() => { setMenu(false); setReporting(true); }}>举报</div>
            {m.state === 'mutual'
              ? <div className="red" onClick={() => { setMenu(false); onEnd(); }}>不合适，不再联系</div>
              : m.state !== 'ended' && <div className="red" onClick={() => { setMenu(false); onPass(); }}>不合适，不再推荐</div>}
          </div>
        </>
      )}
      {reporting && <ReportSheet userId={c.user.id} onClose={() => setReporting(false)} onDone={showToast} />}

      {viewer && <div className="hn-viewer" onClick={() => setViewer('')}><img src={viewer} alt="" /></div>}
      {editing && <EditDialog item={editing} onClose={() => setEditing(null)} onSave={saveEdit} />}
      {toast}
      {likeNode}
    </div>
  );
}

const ghostBtn = { flex: 1, background: 'transparent', color: 'var(--hn-ink)', fontWeight: 500, boxShadow: 'none' } as const;

/** 「12 月 23 日」 */
function dayText(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 改 AI 画像里的一项：改文字，或者删掉这一条（不调模型，不花钱） */
function EditDialog({ item, onClose, onSave }: { item: { key: string; label: string; value: string }; onClose: () => void; onSave: (v: string) => void }) {
  const [v, setV] = useState(item.value);
  const max = item.key === 'summary' ? 80 : 60;
  return (
    <div className="hn-dim center" onClick={onClose}>
      <div className="hn-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 17, fontWeight: 800 }}>{item.label}</div>
        <div className="hn-t2" style={{ marginTop: 4 }}>AI 写得不对就自己改，改和删都不花钱。</div>
        <textarea value={v} maxLength={max} onChange={(e) => setV(e.target.value)} />
        <div className="hn-t3" style={{ textAlign: 'right', marginTop: 4 }}>{v.length}/{max}</div>
        <div className="hn-row" style={{ marginTop: 12 }}>
          {item.key !== 'summary' && <button className="hn-btn flat" style={{ flex: 1, height: 44, fontSize: 14.5, color: '#f04438' }} onClick={() => onSave('')}>删掉这一条</button>}
          <button className="hn-btn" style={{ flex: 1.3, height: 44, fontSize: 15 }} disabled={!v.trim()} onClick={() => onSave(v.trim())}>保存</button>
        </div>
      </div>
    </div>
  );
}
