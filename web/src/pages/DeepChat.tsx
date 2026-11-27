import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, reasonOf } from '../api';
import { useApp } from '../store';
import { CardData, Ic, Nav, Orb, PayOptions, PortraitLink, useToast } from '../hn';

interface DeepMsg {
  id: string;
  role: 'ai' | 'user';
  text: string;
  quick: string[];
  topic: number;
}

interface DeepState {
  profileDone: boolean;
  topics: string[];
  estimate: string;
  wallet: { balance: string; payMode: 'platform' | 'own'; hasKey: boolean; feePercent: number };
  status: 'none' | 'chatting' | 'draft' | 'done';
  topic: number;
  messages: DeepMsg[];
  /** 最后一句是我说的、AI 还没回（上次没回成） */
  pending: boolean;
  canFinish: boolean;
  spent: { cost: string; fee: string; total: string; ownKey: boolean; calls: number } | null;
  done?: boolean;
  fellBack?: boolean;
}

/** 调模型失败时的提示卡：标题、说明、两个按钮 */
const NOTICE: Record<string, { icon: string; title: string; sub: string }> = {
  no_balance: { icon: 'wallet', title: '牵豆不够了，先聊到这里', sub: '你说的都存好了，充值后接着聊。不影响你被推荐和找人聊天。' },
  key_invalid: { icon: 'key', title: '你的 Key 用不了', sub: '可能已经失效了，或者复制得不完整。' },
  key_no_balance: { icon: 'key', title: '你的 Key 没有额度了', sub: '需要去 DeepSeek 后台充值，或者换一种付费方式。' },
  need_key: { icon: 'key', title: '还没有填写你自己的 Key', sub: '填好以后接着聊，或者改用牵豆。' },
  ai_down: { icon: 'info', title: 'AI 暂时没回上话', sub: '不是你的问题，稍等一下再试。这次没有扣费。' },
};

/**
 * AI 深聊：真的大模型在问、在接话。六个话题聊完整理成画像，确认后生效。
 * 可选功能，按用量花模型费（平台余额或自己的 Key）。样稿：design/01-ai-interview.html
 */
export function DeepChatPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const [st, setSt] = useState<DeepState | null>(null);
  const [card, setCard] = useState<CardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [input, setInput] = useState('');
  /** 正在等 AI 回话 / 正在整理画像 */
  const [busy, setBusy] = useState<'' | 'reply' | 'portrait' | 'other'>('');
  /** 我刚发出去、服务端还没返回的那句话（先显示出来） */
  const [sending, setSending] = useState('');
  const [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(false);
  const [toast, showToast] = useToast();
  const bottom = useRef<HTMLDivElement>(null);

  const load = () => {
    setFailed(false);
    api<DeepState>('/hn/deep').then(setSt).catch(() => setFailed(true));
  };
  useEffect(load, []);

  // 画像整理好以后，聊天里放一张卡片，点开是相亲画像网页
  const showLink = st?.status === 'draft' || st?.status === 'done';
  useEffect(() => {
    if (showLink) api<CardData>('/hn/card/me').then(setCard).catch(() => {});
  }, [showLink, st?.status]);

  // 有新内容就滚到底；刚进来那一下直接到位（聊天记录长的时候慢慢滚很难受），之后才用动画
  const firstScroll = useRef(true);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    if (st && (!showLink || card)) firstScroll.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.messages.length, sending, busy, notice, card]);

  const fail = (e: unknown) => {
    const reason = reasonOf(e);
    if (NOTICE[reason]) setNotice(reason);
    else showToast((e as Error).message);
  };

  /** 聊完后把聊天记录整理成画像 */
  const finish = async () => {
    setMenu(false);
    setBusy('portrait');
    try {
      setSt(await api<DeepState>('/hn/deep/finish', { method: 'POST' }));
      setNotice('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };

  /** 说一句 / 点现成回答 / 先不说 / 换个话题；什么都不带 = 让 AI 重新回上一句 */
  const send = async (body: { text?: string; action?: 'skip' | 'next' }) => {
    if (busy || !st) return;
    const shown = body.action === 'skip' ? '先不说' : body.action === 'next' ? '换个话题' : (body.text ?? '').trim();
    if (!shown && !st.pending) return;
    setInput('');
    setNotice('');
    setSending(shown);
    setBusy('reply');
    let next: DeepState | null = null;
    try {
      next = await api<DeepState>('/hn/deep/message', { method: 'POST', body: body.action ? { action: body.action } : { text: shown } });
      setSt(next);
      if (next.fellBack) showToast('你的 Key 用不了，已改用牵豆');
    } catch (e) {
      fail(e);
      // 我说的话服务端已经存下了，重新取一次状态，把它显示出来
      await api<DeepState>('/hn/deep').then(setSt).catch(() => {});
    } finally {
      setSending('');
      setBusy('');
    }
    // AI 说聊完了：接着整理画像
    if (next?.done) void finish();
  };

  const post = async (path: string) => {
    if (busy) return;
    setMenu(false);
    setBusy('other');
    try {
      setSt(await api<DeepState>(path, { method: 'POST' }));
      setNotice('');
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };

  const pickMode = async (payMode: 'platform' | 'own') => {
    try {
      await api('/ai-wallet/mode', { method: 'PUT', body: { payMode } });
      load();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  if (!st) {
    return (
      <div className="hn-page">
        <Nav title="AI 红娘" badge="人工智能" onBack={() => nav(-1)} />
        <div className="hn-t2" style={{ textAlign: 'center', padding: 60 }} onClick={failed ? load : undefined}>{failed ? '没加载出来，点一下重试' : '加载中…'}</div>
      </div>
    );
  }

  const own = st.wallet.payMode === 'own' && st.wallet.hasKey;
  const canStart = own || Number(st.wallet.balance) > 0;
  const lastAi = [...st.messages].reverse().find((m) => m.role === 'ai');
  const chatting = st.status === 'chatting';
  const extra = st.topic >= st.topics.length;
  // 提示卡：上次调用失败的原因；刷新页面后原因丢了，只知道 AI 还没回，就给一个「继续」
  const noticeKey = notice || (chatting && st.pending && !busy ? 'ai_down' : '');
  const n = NOTICE[noticeKey];

  const aiBubble = (text: string, key: string, gen = true) => (
    <div key={key} className="hn-br">
      <Orb />
      <div>
        <div className="hn-bb ai">{text}</div>
        {gen && <div className="hn-gen"><Ic n="spark" s={10} />AI 生成</div>}
      </div>
    </div>
  );
  const myBubble = (text: string, key: string) => (
    <div key={key} className="hn-br me">
      <div className="hn-bb me">{text}</div>
      <div className="hn-meav" style={me?.avatar ? { backgroundImage: `url(${me.avatar})` } : undefined} />
    </div>
  );

  return (
    <div className="hn-page">
      <Nav
        title="AI 红娘" badge="人工智能" onBack={() => nav(-1)}
        right={st.status === 'none' ? undefined : <button className="hn-icbtn" onClick={() => setMenu(true)}><Ic n="more" /></button>}
      />
      {menu && (
        <>
          <div className="hn-menu-mask" onClick={() => setMenu(false)} />
          <div className="hn-menu">
            <div onClick={() => nav(-1)}>先聊到这（已自动保存）</div>
            {chatting && <div className={st.canFinish ? '' : 'off'} onClick={() => st.canFinish && finish()}>聊够了，直接出画像</div>}
            <div onClick={() => nav('/ai-fee/ledger')}>费用明细</div>
            <div className="red" onClick={() => window.confirm('重新聊会从头开始，之前聊的内容不再用来整理画像。确定吗？') && post('/hn/deep/restart')}>重新聊</div>
          </div>
        </>
      )}

      {st.status !== 'none' && (
        <div className="hn-steps">
          {st.topics.map((name, i) => (
            <span key={name} className={i < st.topic || !chatting ? 'ok' : i === st.topic ? 'on' : ''}>
              {(i < st.topic || !chatting) && <Ic n="check" s={10} />}{name}
            </span>
          ))}
        </div>
      )}

      <div className="hn-scroll">
        <div className="hn-chat">
          {st.status === 'none' && aiBubble('你好，我是 AI 红娘，是人工智能，不是真人。', 'hi', false)}
          {st.messages.map((m) => (m.role === 'ai' ? aiBubble(m.text, m.id) : myBubble(m.text, m.id)))}
          {sending && myBubble(sending, 'sending')}
          {busy === 'reply' && <div className="hn-br"><Orb /><div className="hn-bb ai"><span className="hn-dots"><i /><i /><i /></span></div></div>}
          {busy === 'portrait' && aiBubble('正在整理你的相亲画像，稍等几秒…', 'making', false)}
          {showLink && card && <PortraitLink card={card} onOpen={() => nav('/card/me')} />}

          {n && (
            <div className="hn-glass hn-notice">
              <div className="hn-row">
                <span className="hn-sq warn"><Ic n={n.icon} s={18} /></span>
                <div><div style={{ fontSize: 15.5, fontWeight: 800 }}>{n.title}</div><div className="hn-t2" style={{ marginTop: 2, fontSize: 12.5, lineHeight: 1.5 }}>{n.sub}</div></div>
              </div>
              <div className="hn-row" style={{ marginTop: 14, flexWrap: 'wrap' }}>
                {noticeKey === 'no_balance' && <><button className="hn-pill" onClick={() => nav('/ai-fee/topup')}>去充值</button><button className="hn-pill ghost" onClick={() => nav('/ai-fee/key')}>改用我自己的 Key</button></>}
                {(noticeKey === 'key_invalid' || noticeKey === 'key_no_balance') && <><button className="hn-pill" onClick={() => nav('/ai-fee/key')}>换一个 Key</button><button className="hn-pill ghost" onClick={() => pickMode('platform').then(() => setNotice('ai_down'))}>改用牵豆</button></>}
                {noticeKey === 'need_key' && <><button className="hn-pill" onClick={() => nav('/ai-fee/key')}>去填写 Key</button><button className="hn-pill ghost" onClick={() => pickMode('platform').then(() => setNotice('ai_down'))}>改用牵豆</button></>}
                {noticeKey === 'ai_down' && <button className="hn-pill" onClick={() => (st.pending ? send({}) : setNotice(''))}>{st.pending ? '继续' : '知道了'}</button>}
                {noticeKey !== 'ai_down' && st.pending && <button className="hn-pill ghost" onClick={() => send({})}>解决了，继续</button>}
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>

      {/* 底部：聊天中是现成回答 + 输入框；画像等确认时是两个按钮；确认后是「再聊聊」 */}
      {chatting && (
        <div className="hn-dock">
          {!n && !busy && (
            <div className="hn-qr">
              {(lastAi?.quick ?? []).map((q) => <span key={q} onClick={() => send({ text: q })}>{q}</span>)}
              <span className="s" onClick={() => send({ action: 'skip' })}>先不说</span>
              {!extra && <span className="s" onClick={() => send({ action: 'next' })}>换个话题</span>}
              {extra && st.canFinish && <span className="s" onClick={finish}>聊够了，出画像</span>}
            </div>
          )}
          <div className="hn-ibar" style={n ? { marginTop: 0, opacity: 0.5 } : undefined}>
            <input
              value={input} maxLength={500} disabled={!!n || !!busy}
              placeholder={n ? '暂时不能发' : '也可以自己打字…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && input.trim() && send({ text: input })}
            />
            <button className="hn-send" disabled={!!n || !!busy || !input.trim()} onClick={() => send({ text: input })}><Ic n="up" s={20} /></button>
          </div>
          <Cost st={st} onOpen={() => nav('/ai-fee/ledger')} />
        </div>
      )}
      {st.status === 'draft' && (
        <div className="hn-dock">
          <div className="hn-row">
            <button className="hn-btn ghost" style={{ flex: 1 }} disabled={!!busy} onClick={() => post('/hn/deep/resume')}>再聊聊</button>
            <button className="hn-btn" style={{ flex: 1.5 }} disabled={!!busy} onClick={() => post('/hn/deep/confirm')}>确认，就这样</button>
          </div>
          <Cost st={st} total onOpen={() => nav('/ai-fee/ledger')} />
        </div>
      )}
      {st.status === 'done' && (
        <div className="hn-dock">
          <button className="hn-btn ghost" disabled={!!busy} onClick={() => post('/hn/deep/resume')}><Ic n="spark" s={16} />再和 AI 聊聊</button>
        </div>
      )}

      {/* 第一次进来：说明 + 选谁付模型费 */}
      {st.status === 'none' && (
        <div className="hn-dim" style={{ position: 'absolute' }}>
          <div className="hn-sheet">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: -30 }}>
              <Orb size="lg" />
              <div style={{ fontSize: 21, fontWeight: 800, marginTop: 22 }}>和 AI 红娘深聊</div>
              <div className="hn-aib" style={{ fontSize: 12, padding: '4px 12px', borderRadius: 12, marginTop: 8 }}>我是人工智能，不是真人</div>
            </div>
            <div className="hn-feat" style={{ marginTop: 16 }}><span className="hn-sq"><Ic n="clock" s={18} /></span><span>大约 10 分钟，聊性格、生活习惯、对家庭的想法和想找的人</span></div>
            <div className="hn-feat"><span className="hn-sq"><Ic n="shield" s={18} /></span><span>不想说的就说「先不说」，随时能停，下次接着聊</span></div>
            <div className="hn-feat"><span className="hn-sq"><Ic n="spark" s={18} /></span><span>聊完整理成画像，你确认了才生效</span></div>

            {st.profileDone ? (
              <>
                <div className="hn-row" style={{ marginTop: 18 }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>费用怎么付</span>
                  <span className="hn-t2" style={{ marginLeft: 'auto', fontSize: 12 }}>这次预计 <b style={{ color: 'var(--hn-rose)' }}>{st.estimate}</b> 牵豆以内</span>
                </div>
                <PayOptions wallet={st.wallet} onPick={pickMode} onGoKey={() => nav('/ai-fee/key')} onGoTopup={() => nav('/ai-fee/topup')} />
                <button className="hn-btn" style={{ marginTop: 16 }} disabled={!canStart || !!busy} onClick={() => post('/hn/deep/start')}>开始聊</button>
                <div className="hn-t3" style={{ textAlign: 'center', marginTop: 10 }}>{canStart ? '不聊也不影响你被推荐和找人聊天' : '牵豆是 0，也没有填 Key：先充值，或者填自己的 Key'}</div>
              </>
            ) : (
              <>
                <div className="hn-t2" style={{ marginTop: 18, lineHeight: 1.7 }}>深聊之前，先把基本情况的问答做完（免费，大概 3 分钟）。</div>
                <button className="hn-btn" style={{ marginTop: 14 }} onClick={() => nav('/interview', { replace: true })}>先去填基本情况</button>
              </>
            )}
            <button className="hn-btn flat" style={{ marginTop: 10, height: 44, fontSize: 14.5 }} onClick={() => nav(-1)}>以后再说</button>
          </div>
        </div>
      )}
      {toast}
    </div>
  );
}

/** 最下面的小胶囊：这次花了多少、余额还剩多少，点一下看明细 */
function Cost({ st, total, onOpen }: { st: DeepState; total?: boolean; onOpen: () => void }) {
  const s = st.spent;
  if (!s) return null;
  const ownNow = st.wallet.payMode === 'own' && st.wallet.hasKey;
  return (
    <div className="hn-cost" onClick={onOpen}>
      {s.ownKey || (ownNow && s.calls === 0)
        ? <span>用的是你自己的 Key，平台没有扣费</span>
        : total
          ? <span>本次共花 <b>{s.total}</b> 牵豆（模型费 {s.cost} + 手续费 {s.fee}）</span>
          : <span>本次已花 <b>{s.total}</b> 牵豆 · {ownNow ? '现在用你自己的 Key' : <>还剩 <b>{st.wallet.balance}</b></>}</span>}
      <Ic n="right" s={12} />
    </div>
  );
}
