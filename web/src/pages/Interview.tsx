import { CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { useApp } from '../store';
import { CityPickerSheet, HOT_CITIES } from '../components/CityPicker';
import { t } from '../i18n';
import { CardData, Ic, PortraitLink } from '../hn';

interface Question {
  key: string;
  label: string;
  ask: string;
  type: 'single' | 'multi' | 'text' | 'number' | 'city';
  options: string[];
  max: number;
  min: number;
  hint: string;
  /** number 题的滚轮：每一格的文字，第 i 格的值是 min + i */
  wheel?: string[];
  /** number 题滚轮一开始停在哪个值 */
  def?: number;
  /** single 题：选项里没有可以自己填 */
  custom?: boolean;
  /** text 题：示例句，点一下填进输入框 */
  samples?: string[];
  optional: boolean;
  pref: boolean;
  answered: boolean;
  value: string[];
  display: string;
}

interface InterviewState {
  intro: string[];
  outro: string;
  confirmedText: string;
  skipText: string;
  questions: Question[];
  complete: boolean;
  confirmed: boolean;
  profile: { summary: string; tags: string[] } | null;
}

const AI_AVATAR = (
  <div style={{
    width: 36, height: 36, borderRadius: 18, flexShrink: 0,
    background: 'var(--accent-grad)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontSize: 12, fontWeight: 800, letterSpacing: 1,
  }}>AI</div>
);

const chip = (active: boolean): CSSProperties => ({
  padding: '9px 14px', borderRadius: 18, fontSize: 14, cursor: 'pointer', userSelect: 'none',
  background: active ? 'var(--accent-grad)' : 'var(--bg-input)',
  color: active ? '#fff' : 'var(--text)',
});

const WHEEL_ROW = 40;

/** 滚轮每一格的文字（服务端给了就用服务端的，出生年份会带岁数） */
const wheelLabels = (q: Question) =>
  q.wheel?.length ? q.wheel : Array.from({ length: Math.max(q.max - q.min + 1, 1) }, (_, i) => String(q.min + i));

/** 滚轮一开始停在第几格：改答案时停在原来的值，否则停在默认值 */
const wheelStart = (q: Question) => {
  const n = Number(q.value[0]) || q.def || q.min;
  return Math.min(Math.max(n - q.min, 0), wheelLabels(q).length - 1);
};

/** 滚轮：上下拨，停在中间那一格就是选中的（出生年份、身高用） */
function Wheel({ labels, start, index, onChange }: { labels: string[]; start: number; index: number; onChange: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // 只在刚出现时把滚轮拨到 start，之后跟着手指走
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = start * WHEEL_ROW;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div style={{ position: 'relative', height: WHEEL_ROW * 5 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: WHEEL_ROW * 2, height: WHEEL_ROW, background: 'var(--bg-input)', borderRadius: 12, pointerEvents: 'none' }} />
      <div
        ref={ref}
        className="no-scrollbar"
        style={{ position: 'relative', height: '100%', overflowY: 'auto', scrollSnapType: 'y mandatory', padding: `${WHEEL_ROW * 2}px 0`, boxSizing: 'border-box' }}
        onScroll={(e) => {
          const i = Math.min(labels.length - 1, Math.max(0, Math.round(e.currentTarget.scrollTop / WHEEL_ROW)));
          if (i !== index) onChange(i);
        }}
      >
        {labels.map((label, i) => (
          <div
            key={i}
            onClick={() => ref.current?.scrollTo({ top: i * WHEEL_ROW, behavior: 'smooth' })}
            style={{
              height: WHEEL_ROW, lineHeight: `${WHEEL_ROW}px`, textAlign: 'center', scrollSnapAlign: 'center', cursor: 'pointer',
              fontSize: i === index ? 18 : 15, fontWeight: i === index ? 700 : 400,
              color: i === index ? 'var(--text)' : 'var(--text-3)',
            }}
          >{label}</div>
        ))}
      </div>
    </div>
  );
}

/**
 * AI 红娘资料收集（「编辑资料」进来就是这里）：聊天样式的一问一答，题目是服务端按性别给的固定模板。
 * 答一题存一题，中途退出下次接着问；全部答完出相亲画像，确认后才算完成；之后点画像里任意一行可以改。
 */
export function InterviewPage() {
  const nav = useNavigate();
  const fromRegister = !!(useLocation().state as { fromRegister?: boolean } | null)?.fromRegister;
  const me = useApp((s) => s.user);
  const [st, setSt] = useState<InterviewState | null>(null);
  const [failed, setFailed] = useState(false);
  /** 画像出来以后，正在重新回答的那一题 */
  const [editing, setEditing] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  /** 滚轮停在第几格 */
  const [wheelIdx, setWheelIdx] = useState(0);
  /** 多行输入框正在打字 */
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCity, setShowCity] = useState(false);
  const [toast, setToast] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  /** 从相亲画像网页点某一项过来改（网址带 ?edit=题目）：改完直接回画像网页 */
  const fromCard = useSearchParams()[0].get('edit');
  /** 答完以后聊天里放的那张画像卡片（点开是相亲画像网页） */
  const [link, setLink] = useState<CardData | null>(null);
  /** AI 深聊做了没有：没做过的，确认基本画像后邀请一下 */
  const [deep, setDeep] = useState<UserProfile['deepStatus']>(me?.deepStatus);
  const [inviteOff, setInviteOff] = useState(false);
  /** 实人认证：后台要求且还没认证时，答完题后提示「最后一步」 */
  const [kyc, setKyc] = useState<{ required: boolean; realname: boolean } | null>(null);

  const load = () => {
    setFailed(false);
    api<InterviewState>('/hn/interview')
      .then((s) => {
        setSt(s);
        if (fromCard && s.questions.some((q) => q.key === fromCard)) setEditing(fromCard);
      })
      .catch(() => setFailed(true));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!st?.complete) return;
    api<CardData>('/hn/card/me').then(setLink).catch(() => {});
    api<UserProfile>('/user/me').then((u) => setDeep(u.deepStatus)).catch(() => {});
    api<{ required: boolean; realname: boolean }>('/kyc/status').then(setKyc).catch(() => {});
  }, [st?.complete, st?.confirmed, st?.profile?.summary]);

  const current = !st ? null
    : editing ? st.questions.find((q) => q.key === editing) ?? null
      : st.questions.find((q) => !q.answered) ?? null;
  const answeredCount = st?.questions.filter((q) => q.answered).length ?? 0;

  // 换题时重置回答区；改已经答过的题时带上原来的回答（多选的勾、滚轮的位置、自己填的字）
  useEffect(() => {
    const old = current?.value[0] ?? '';
    const typed = !!current && !!old && (current.type === 'text' || (current.type === 'single' && !current.options.includes(old)));
    setInput(typed ? old : '');
    setTyping(false);
    setPicked(current?.type === 'multi' ? current.value : []);
    if (current?.type === 'number') setWheelIdx(wheelStart(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.key, editing]);

  // 有新内容就滚到底，让当前这道题始终露在回答区上面；刚进来那一下直接到位，之后才用动画
  const firstScroll = useRef(true);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    if (st) firstScroll.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answeredCount, editing, st?.complete, st?.confirmed, current?.key]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const submit = async (value: string[]) => {
    if (!current || busy) return;
    setBusy(true);
    try {
      setSt(await api<InterviewState>('/hn/interview/answer', { method: 'POST', body: { key: current.key, value } }));
      // 从画像网页点过来改的：改完回画像网页
      if (fromCard && editing === fromCard) return nav(-1);
      setEditing(null);
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setSt(await api<InterviewState>('/hn/interview/confirm', { method: 'POST' }));
      showToast(t('hn.done'));
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const back = () => (fromRegister ? nav('/plaza', { replace: true }) : nav(-1));

  const aiBubble = (text: string, key: string) => (
    <div key={key} className="bubble-row" style={{ gap: 8, alignItems: 'flex-start' }}>
      {AI_AVATAR}
      <div className="bubble-wrap">
        <div className="bubble theirs" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
      </div>
    </div>
  );
  const myBubble = (text: string, key: string) => (
    <div key={key} className="bubble-row mine" style={{ gap: 8, alignItems: 'flex-start' }}>
      <div className="bubble-wrap">
        <div className="bubble mine" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
      </div>
      <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0 }}>
        {me?.avatar && <img src={me.avatar} alt="" />}
      </div>
    </div>
  );

  /**
   * 答完以后：聊天里只放一张画像卡片（像一条网页链接），点开是相亲画像网页，头像、昵称、照片、每一项都在那一页；
   * 想改哪一项，在那一页点它，会回到这里重新回答。原来这里那张很长的表格去掉了（用户 2026-11-23 要求）。
   */
  const card = (s: InterviewState) => (
    <>
      {link && <PortraitLink card={link} onOpen={() => nav('/card/me')} />}
      {!s.confirmed && !editing && (
        <div style={{ margin: '0 0 12px 47px', maxWidth: 330 }}>
          <button className="hn-btn" disabled={busy} onClick={confirm}>{t('hn.confirm')}</button>
          <div className="hn-t3" style={{ textAlign: 'center', marginTop: 8 }}>哪里不对，点开上面的画像，点那一项就能改</div>
        </div>
      )}
      {/* 基本画像确认后，没深聊过的邀请一下（可选，花一点模型费） */}
      {s.confirmed && !editing && deep === 'none' && !inviteOff && (
        <>
          {aiBubble('想让我更了解你吗？和我深聊 10 分钟，聊聊性格和想法，推荐会更准。这一步用的是真的 AI，会花几分钱的模型费，不聊也不影响你找人聊天。', 'invite')}
          <div className="hn-row" style={{ margin: '0 0 12px 47px', maxWidth: 330 }}>
            <button className="hn-btn ghost" style={{ flex: 1, height: 44, fontSize: 14.5 }} onClick={() => setInviteOff(true)}>以后再说</button>
            <button className="hn-btn" style={{ flex: 1.4, height: 44, fontSize: 15 }} onClick={() => nav('/deep')}>开始深聊</button>
          </div>
        </>
      )}
    </>
  );

  /** 城市题：自己所在的城市 + 热门城市直接点，其余的点「其他城市」打开完整列表 */
  const cityChips = (q: Question) => {
    const mine = [q.value[0], me?.cityName].filter((c): c is string => !!c);
    const list = [...new Set([...mine, ...HOT_CITIES])];
    return (
      <div className="no-scrollbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: '34vh', overflowY: 'auto' }}>
        {list.map((c) => (
          <span key={c} style={chip(c === q.value[0])} onClick={() => void submit([c])}>{c}</span>
        ))}
        <span style={{ ...chip(false), color: 'var(--accent)' }} onClick={() => !busy && setShowCity(true)}>{t('hn.moreCity')} ›</span>
      </div>
    );
  };

  /** 底部回答区：每种题一种回答方式（滚轮 / 点选项 / 多选 / 点城市 / 多行输入） */
  const answerArea = (q: Question, s: InterviewState) => (
    <div style={{ padding: '10px 12px calc(10px + env(safe-area-inset-bottom))', background: 'var(--bg-card)', borderTop: '1px solid var(--line)' }}>
      {q.type === 'number' && (
        <>
          <Wheel key={`${q.key}_${editing ?? ''}`} labels={wheelLabels(q)} start={wheelStart(q)} index={wheelIdx} onChange={setWheelIdx} />
          <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={() => submit([String(q.min + wheelIdx)])}>{t('common.ok')}</button>
        </>
      )}
      {(q.type === 'single' || q.type === 'multi') && (
        <div className="no-scrollbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: '34vh', overflowY: 'auto' }}>
          {q.options.map((o) => {
            // 单选题改答案时，原来选的那个亮着
            const on = q.type === 'multi' ? picked.includes(o) : q.value[0] === o;
            return (
              <span
                key={o}
                style={chip(on)}
                onClick={() => {
                  if (q.type === 'single') return void submit([o]);
                  if (on) setPicked(picked.filter((x) => x !== o));
                  else if (picked.length >= q.max) showToast(q.ask);
                  else setPicked([...picked, o]);
                }}
              >{o}</span>
            );
          })}
        </div>
      )}
      {/* 单选题带「自己填」：选项里没有合适的就在这里打字 */}
      {q.type === 'single' && q.custom && (
        <div className="row" style={{ gap: 8, marginTop: 10 }}>
          <input
            className="input grow"
            style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
            value={input}
            maxLength={q.max || 20}
            placeholder={q.hint || t('hn.inputHint')}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && input.trim() && submit([input.trim()])}
          />
          <button className="btn-sm" style={{ height: 40, borderRadius: 20, flexShrink: 0 }} disabled={!input.trim() || busy} onClick={() => submit([input.trim()])}>
            {t('common.send')}
          </button>
        </div>
      )}
      {/* 填空题：示例句点一下填进去，再自己改 */}
      {q.type === 'text' && (
        <>
          {/* 正在打字时（手机上键盘弹起来）屏幕不够高，示例句先收起 */}
          {!!q.samples?.length && !typing && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>{t('hn.sampleHint')}</div>
              <div className="no-scrollbar" style={{ maxHeight: '24vh', overflowY: 'auto', marginBottom: 10 }}>
                {q.samples.map((sample) => (
                  <div
                    key={sample}
                    onClick={() => setInput(sample.slice(0, q.max || 100))}
                    style={{ padding: '9px 12px', borderRadius: 12, fontSize: 13, lineHeight: 1.5, marginBottom: 6, cursor: 'pointer', background: 'var(--bg-input)', color: 'var(--text)' }}
                  >{sample}</div>
                ))}
              </div>
            </>
          )}
          <textarea
            className="input"
            rows={3}
            style={{ marginBottom: 0, borderRadius: 14, height: 'auto', padding: '10px 14px', lineHeight: 1.6, resize: 'none', display: 'block', width: '100%', boxSizing: 'border-box', fontFamily: 'inherit' }}
            value={input}
            maxLength={q.max || 100}
            placeholder={q.hint || t('hn.inputHint')}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
          />
        </>
      )}
      {q.type === 'city' && cityChips(q)}
      <div className="row" style={{ gap: 10, marginTop: 10, justifyContent: 'flex-end', alignItems: 'center' }}>
        {editing && <span className="muted" style={{ fontSize: 14, cursor: 'pointer', marginRight: 'auto' }} onClick={() => (fromCard && editing === fromCard ? nav(-1) : setEditing(null))}>{t('common.cancel')}</span>}
        {q.optional && <span className="muted" style={{ fontSize: 14, cursor: 'pointer' }} onClick={() => submit([])}>{s.skipText}</span>}
        {q.type === 'multi' && (
          <button className="btn-sm" style={{ borderRadius: 18 }} disabled={picked.length === 0 || busy} onClick={() => submit(picked)}>
            {t('hn.multiDone', { n: picked.length })}
          </button>
        )}
        {q.type === 'text' && (
          <>
            <span className="muted" style={{ fontSize: 12 }}>{input.length}/{q.max || 100}</span>
            <button className="btn-sm" style={{ borderRadius: 18 }} disabled={!input.trim() || busy} onClick={() => submit([input.trim()])}>
              {t('common.send')}
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={back}>‹</span>
        <span className="title">
          {t('hn.title')}
          <span style={{ fontSize: 10, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 4, padding: '1px 5px', marginLeft: 6, verticalAlign: 'middle' }}>{t('hn.aiBadge')}</span>
        </span>
        <span className="action" style={{ color: 'var(--text-2)', fontSize: 12 }}>
          {st ? t('hn.progress', { n: answeredCount, total: st.questions.length }) : ''}
        </span>
      </div>

      <div className="page page-pad">
        {!st && <div className="empty" onClick={failed ? load : undefined}>{failed ? t('hn.loadFailed') : t('common.loading')}</div>}
        {st && (
          <>
            {/* 还没答完：开场白 + 已经答过的一问一答；答完后只留画像，不重放整段对话 */}
            {!st.complete && st.intro.map((s, i) => aiBubble(s, `intro${i}`))}
            {!st.complete && st.questions.filter((q) => q.answered).map((q) => (
              <div key={q.key}>
                {aiBubble(q.ask, `q_${q.key}`)}
                {myBubble(q.display, `a_${q.key}`)}
              </div>
            ))}
            {/* 网页端答完后是一张画像卡片（点开是网页），话术跟着改；原生端还是服务端下发的那两句 */}
            {st.complete && aiBubble(
              st.confirmed
                ? '你的资料已经收集完成，可以去找人聊天了。想改哪一项，点开下面的画像，点那一项就行。'
                : '都问完了。我把你的相亲画像整理成了一页，点开看看对不对，没问题就点「确认」。',
              'outro',
            )}
            {st.complete && card(st)}
            {/* 最后一步：实人认证（后台开关开着且还没认证时）。完成基础画像 = 答完题 + 实人认证 + 确认 */}
            {st.complete && !editing && kyc?.required && !kyc.realname && (
              <div className="hn-glass" style={{ margin: '0 0 14px 47px', maxWidth: 330, borderRadius: 18, padding: 16 }}>
                <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  <span className="hn-sq" style={{ flexShrink: 0 }}><Ic n="shield" s={18} /></span>
                  <div><div style={{ fontWeight: 700, fontSize: 15 }}>最后一步：实人认证</div><div className="hn-t3" style={{ marginTop: 3, lineHeight: 1.5 }}>身份证 + 刷脸，做完才能发动态、评论、视频见面。¥1 从 AI 余额扣。</div></div>
                </div>
                <button className="hn-btn" style={{ marginTop: 12, height: 44 }} onClick={() => nav('/kyc?next=/interview')}><Ic n="camera" s={17} />去完成实人认证</button>
              </div>
            )}
            {editing && current && aiBubble(t('hn.editAgain'), 'again')}
            {current && aiBubble(current.ask, `ask_${current.key}`)}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {st && current && answerArea(current, st)}

      {showCity && (
        <CityPickerSheet
          current={current?.value[0] ?? me?.cityName ?? ''}
          onClose={() => setShowCity(false)}
          onSelect={(city) => { setShowCity(false); void submit([city]); }}
        />
      )}

      {toast && (
        <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 200, background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 14, padding: '10px 18px', borderRadius: 20, maxWidth: '86%' }}>
          {toast}
        </div>
      )}
    </div>
  );
}
