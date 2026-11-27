import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AiWalletView, Ic, Nav, PayOptions, useBack, useToast } from '../hn';

/**
 * 牵豆（2026-11-27 之前叫「AI 余额」，1 元 = 1 牵豆）：余额、AI 的付费方式（用牵豆 / 自己的 Key）、明细、充值、填 Key。
 * AI 功能、真人认证、视频见面都从牵豆里扣。AI 的规则（用户 2026-11-23 定）：用牵豆 = DeepSeek 实际费用 + 10% 手续费；自己的 Key 平台不收费。
 * 样稿：design/02-ai-fee.html；改名和充值页的样子见 design/10-qiandou.html
 */

function useWallet() {
  const [w, setW] = useState<AiWalletView | null>(null);
  const reload = () => api<AiWalletView>('/ai-wallet').then(setW).catch(() => {});
  useEffect(() => { void reload(); }, []);
  return [w, setW, reload] as const;
}

const payView = (w: AiWalletView) => ({ balance: w.balance, payMode: w.payMode, hasKey: !!w.key, feePercent: w.feePercent });

/** 费用首页 */
export function AiFeePage() {
  const nav = useNavigate();
  const back = useBack();
  const [w, setW] = useWallet();
  const [toast, showToast] = useToast();

  const pick = async (payMode: 'platform' | 'own') => {
    try {
      setW(await api<AiWalletView>('/ai-wallet/mode', { method: 'PUT', body: { payMode } }));
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  return (
    <div className="hn-page">
      <Nav title="我的牵豆" onBack={back} right={<button className="hn-icbtn" onClick={() => nav('/ai-fee/ledger')}><Ic n="list" /></button>} />
      <div className="hn-scroll" style={{ paddingBottom: 30 }}>
        <div className="hn-pad" style={{ marginTop: 6 }}>
          <div className="hn-hero-card">
            <div style={{ fontSize: 13, opacity: 0.92 }}>牵豆 · 1 牵豆 = 1 元</div>
            <div className="hn-bal">{w?.balance ?? '--'}</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 2 }}>视频见面、AI 功能、真人认证都从这里扣；发消息、语音不花牵豆</div>
            <div className="hn-row" style={{ marginTop: 14 }}>
              <button className="hn-pill w" style={{ padding: '0 22px' }} onClick={() => nav('/ai-fee/topup')}>充值</button>
              <button className="hn-pill g" onClick={() => nav('/ai-fee/ledger')}><Ic n="list" s={14} />明细</button>
            </div>
          </div>
        </div>

        <div className="hn-ttl">AI 功能的费用，用哪种方式付</div>
        <div className="hn-pad">
          {w && <PayOptions wallet={payView(w)} onPick={pick} onGoKey={() => nav('/ai-fee/key')} />}
          {w?.key && (
            <div className="hn-t2" style={{ margin: '10px 4px 0', fontSize: 12.5, color: 'var(--hn-rose)', fontWeight: 600, cursor: 'pointer' }} onClick={() => nav('/ai-fee/key')}>管理我的 Key（sk-····{w.key.tail}）›</div>
          )}
        </div>

        <div className="hn-ttl">怎么收费</div>
        <div className="hn-pad">
          <div className="hn-glass" style={{ padding: '4px 14px 14px' }}>
            {w && w.videoPerMin !== undefined && Number(w.videoPerMin) > 0 && (
              <div className="hn-feat"><span className="hn-sq"><Ic n="video" s={18} /></span><span>视频见面 {w.videoPerMin} 牵豆 / 分钟，由男方支付；不满 1 分钟按 1 分钟</span></div>
            )}
            <div className="hn-feat"><span className="hn-sq"><Ic n="info" s={18} /></span><span>AI 功能：DeepSeek 收多少就扣多少，另加 {w?.feePercent ?? 10}% 手续费</span></div>
            <div className="hn-feat"><span className="hn-sq"><Ic n="list" s={18} /></span><span>每花一笔都有明细，AI 的模型费和手续费分开写</span></div>
            <div className="hn-feat"><span className="hn-sq"><Ic n="key" s={18} /></span><span>AI 功能用你自己的 Key 时，平台不收任何费用</span></div>
            <div className="hn-feat"><span className="hn-sq"><Ic n="shield" s={18} /></span><span>牵豆用完只是视频和 AI 功能暂停，推荐、发消息、语音照常</span></div>
          </div>
        </div>
      </div>
      {toast}
    </div>
  );
}

interface LedgerItem {
  kind: 'usage' | 'topup';
  groupKey: string;
  title: string;
  time: string;
  ownKey: boolean;
  cost: string;
  fee: string;
  amount: string;
  note: string;
}

interface UsageDetail {
  title: string;
  from: string;
  to: string;
  model: string;
  inTokens: number;
  hitTokens: number;
  outTokens: number;
  ownKey: boolean;
  cost: string;
  fee: string;
  total: string;
  feePercent: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 费用明细：一次深聊合成一条，点开看模型费和手续费 */
export function AiLedgerPage() {
  const nav = useNavigate();
  const back = useBack();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [kind, setKind] = useState<'all' | 'spend' | 'topup'>('all');
  const [data, setData] = useState<{ month: string; spend: string; topup: string; items: LedgerItem[] } | null>(null);
  const [open, setOpen] = useState('');
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    setData(null);
    api(`/ai-wallet/ledger?month=${month}&kind=${kind}`).then(setData).catch((e) => showToast(e.message));
  }, [month, kind]);

  /** 往前 / 往后翻一个月 */
  const shift = (delta: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    if (d.getTime() > Date.now()) return;
    setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  };

  const showDetail = (groupKey: string) => {
    api<UsageDetail>(`/ai-wallet/usage/${encodeURIComponent(groupKey)}`).then(setDetail).catch((e) => showToast(e.message));
  };

  return (
    <div className="hn-page">
      <Nav title="费用明细" onBack={back} />
      <div className="hn-seg">
        {([['all', '全部'], ['spend', '花掉的'], ['topup', '充值']] as const).map(([k, label]) => (
          <span key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label}</span>
        ))}
      </div>
      <div className="hn-row" style={{ padding: '14px 22px 10px', flexShrink: 0 }}>
        <span onClick={() => shift(-1)}><Ic n="left" s={14} style={{ color: 'var(--hn-ink2)', cursor: 'pointer' }} /></span>
        <b style={{ fontSize: 14 }}>{month.replace('-', ' 年 ')} 月</b>
        <span onClick={() => shift(1)}><Ic n="right" s={14} style={{ color: 'var(--hn-ink2)', cursor: 'pointer' }} /></span>
        <span className="hn-t2 hn-num" style={{ marginLeft: 'auto', fontSize: 12 }}>花掉 {data?.spend ?? '--'} · 充值 {data?.topup ?? '--'} 牵豆</span>
      </div>
      <div className="hn-scroll" style={{ paddingBottom: 30 }}>
        <div className="hn-pad">
          {data && data.items.length === 0 && <div className="hn-t2" style={{ textAlign: 'center', padding: 50 }}>这个月还没有记录</div>}
          {data && data.items.length > 0 && (
            <div className="hn-glass" style={{ overflow: 'hidden' }}>
              {data.items.map((it, i) => {
                const id = it.groupKey || `row${i}`;
                // 只有 AI 调用（有 groupKey）能点开看模型费和手续费；视频见面、真人认证、充值是一笔固定的数，没有可展开的细账
                const canOpen = it.kind === 'usage' && !!it.groupKey;
                const isOpen = canOpen && open === id;
                return (
                  <div key={id}>
                    <div className={`hn-lg${i ? ' top' : ''}`} onClick={() => canOpen && setOpen(isOpen ? '' : id)}>
                      <span className={`hn-sq${it.kind === 'topup' ? ' ok' : ''}`}><Ic n={it.kind === 'topup' ? 'plus' : it.title.includes('视频') ? 'video' : it.title.includes('认证') || it.title.includes('刷脸') ? 'shield' : it.title.includes('深聊') ? 'chat' : 'spark'} s={18} /></span>
                      <div className="hn-grow">
                        <div style={{ fontSize: 15, fontWeight: 600 }}>{it.title}</div>
                        <div className="hn-t3" style={{ marginTop: 3 }}>{fmtTime(it.time)}{it.note ? ` · ${it.note}` : ''}</div>
                      </div>
                      {it.kind === 'topup'
                        ? <span className="hn-amt in">+{it.amount}</span>
                        : it.ownKey ? <span className="hn-t2" style={{ fontSize: 12.5 }}>自己的 Key</span> : <span className="hn-amt">−{it.amount}</span>}
                      {canOpen ? <Ic n={isOpen ? 'down' : 'right'} s={14} style={{ color: isOpen ? 'var(--hn-rose)' : 'var(--hn-ink3)' }} /> : <span style={{ width: 14 }} />}
                    </div>
                    {isOpen && (
                      <div className="hn-open">
                        {it.ownKey ? (
                          <div className="hn-kv"><span>用的是你自己的 Key，平台没有扣费</span></div>
                        ) : (
                          <>
                            <div className="hn-kv"><span>模型费（DeepSeek 实际收费）</span><b>{it.cost}</b></div>
                            <div className="hn-kv"><span>平台手续费 10%</span><b>{it.fee}</b></div>
                            <div className="hn-kv" style={{ borderTop: '1px dashed var(--hn-line)', marginTop: 2, paddingTop: 9 }}><span style={{ color: 'var(--hn-ink)', fontWeight: 700 }}>合计（牵豆）</span><b style={{ color: 'var(--hn-rose)', fontWeight: 800 }}>{it.amount}</b></div>
                          </>
                        )}
                        <div className="hn-row" style={{ fontSize: 12, color: 'var(--hn-rose)', fontWeight: 600, padding: '4px 0 6px', gap: 3, cursor: 'pointer' }} onClick={() => showDetail(it.groupKey)}>看用量详情<Ic n="right" s={12} /></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="hn-t3" style={{ textAlign: 'center', marginTop: 14, lineHeight: 1.7 }}>单位是牵豆（1 牵豆 = 1 元），精确到 0.0001，因为 AI 一次调用只有几厘钱</div>
        </div>
      </div>

      {detail && (
        <div className="hn-dim" onClick={() => setDetail(null)}>
          <div className="hn-sheet" style={{ paddingTop: 22 }} onClick={(e) => e.stopPropagation()}>
            <div className="hn-row">
              <span className="hn-sq lg"><Ic n="chat" s={20} /></span>
              <div className="hn-grow"><div style={{ fontSize: 18, fontWeight: 800 }}>{detail.title}</div><div className="hn-t2" style={{ marginTop: 2, fontSize: 12.5 }}>{fmtTime(detail.from)} – {fmtTime(detail.to).slice(6)}</div></div>
              <button className="hn-icbtn" style={{ background: '#f5f0f1', boxShadow: 'none' }} onClick={() => setDetail(null)}><Ic n="x" /></button>
            </div>
            <div style={{ marginTop: 16, padding: '6px 14px', borderRadius: 18, background: '#faf6f6' }}>
              <div className="hn-kv"><span>用的模型</span><b>{detail.model}</b></div>
              <div className="hn-kv"><span>AI 读的内容</span><b>{detail.inTokens.toLocaleString()} tokens</b></div>
              <div className="hn-kv sub"><span>其中重复读的（便宜很多）</span><b>{detail.hitTokens.toLocaleString()}</b></div>
              <div className="hn-kv"><span>AI 写的内容</span><b>{detail.outTokens.toLocaleString()} tokens</b></div>
            </div>
            <div style={{ marginTop: 10, padding: '6px 14px', borderRadius: 18, background: '#fff7f5' }}>
              {detail.ownKey ? (
                <div className="hn-kv"><span>用的是你自己的 Key，平台没有扣牵豆。按官方价估算，DeepSeek 那边大约收了 {detail.cost} 元，以 DeepSeek 后台为准。</span></div>
              ) : (
                <>
                  <div className="hn-kv"><span>模型费（DeepSeek 实际收费）</span><b>{detail.cost}</b></div>
                  <div className="hn-kv"><span>平台手续费 {detail.feePercent}%</span><b>{detail.fee}</b></div>
                  <div className="hn-kv" style={{ borderTop: '1px dashed var(--hn-line)', marginTop: 2, paddingTop: 10 }}><span style={{ color: 'var(--hn-ink)', fontWeight: 700, fontSize: 15 }}>合计，扣牵豆</span><b style={{ color: 'var(--hn-rose)', fontWeight: 800, fontSize: 17 }}>{detail.total}</b></div>
                </>
              )}
            </div>
            <a className="hn-row" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--hn-rose)', fontWeight: 600, gap: 3, textDecoration: 'none' }} href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" target="_blank" rel="noreferrer"><Ic n="link" s={13} />DeepSeek 官方价格<Ic n="right" s={12} /></a>
            <div className="hn-t3" style={{ marginTop: 8, lineHeight: 1.6 }}>token 是模型算字数的单位。晚上、周末是 DeepSeek 的空闲时段，价格是白天的一半。</div>
            <button className="hn-btn flat" style={{ marginTop: 16 }} onClick={() => setDetail(null)}>知道了</button>
          </div>
        </div>
      )}
      {toast}
    </div>
  );
}

/** 充值档位（牵豆 = 元），最少充 1。服务器会下发同一份（AiWalletView.topupAmounts），这里是没取到时用的 */
const AMOUNTS = [1, 5, 10, 30, 50, 100];

/**
 * 充值牵豆：页面先做好，收款接好之前只能看（样稿 design/10-qiandou.html 第 3 组）。
 * 收款以后怎么接：安卓 / 网页走微信、支付宝；iOS 必须走苹果内购（App 里买、App 里用的额度不能用别的方式收款）。
 * 充值买来的牵豆只能花，不能提现、不能转给别人、不过期——页面最底下写着，别删。
 */
export function AiTopupPage() {
  const back = useBack();
  const [w] = useWallet();
  const [amount, setAmount] = useState(1);
  const can = !!w?.canTopup;
  const amounts = w?.topupAmounts?.length ? w.topupAmounts : AMOUNTS;
  const videoPerMin = Number(w?.videoPerMin ?? 0);

  return (
    <div className="hn-page">
      <Nav title="充值牵豆" onBack={back} />
      <div className="hn-scroll" style={{ paddingBottom: 30 }}>
        {!can && <div className="hn-banner"><Ic n="info" s={15} style={{ marginTop: 2 }} /><span>收款还在开通，现在不能自己充值。测试期间的牵豆由平台发放。</span></div>}
        <div className="hn-row" style={{ padding: '14px 22px 0' }}>
          <span className="hn-t2">我的牵豆</span><b className="hn-num" style={{ fontSize: 16 }}>{w?.balance ?? '--'}</b>
          <span className="hn-t3" style={{ marginLeft: 'auto' }}>1 牵豆 = 1 元</span>
        </div>

        <div className="hn-ttl" style={{ marginTop: 14 }}>充多少</div>
        <div className="hn-pad" style={{ marginTop: 8 }}>
          <div className="hn-tiles">
            {amounts.map((a) => (
              <div key={a} className={`hn-tile${amount === a ? ' on' : ''}`} onClick={() => setAmount(a)}>{a}<small>{a} 元</small></div>
            ))}
          </div>
        </div>
        <div className="hn-pad" style={{ marginTop: 12 }}>
          <div className="hn-glass" style={{ padding: '11px 14px', borderRadius: 16, fontSize: 12.5, lineHeight: 1.6, color: 'var(--hn-ink2)', display: 'flex', gap: 8 }}>
            <Ic n="info" s={15} style={{ color: 'var(--hn-rose)', marginTop: 2 }} />
            <span>{videoPerMin > 0 ? `1 牵豆够视频 ${Math.floor(1 / videoPerMin)} 分钟，` : ''}AI 深聊一次只要几分钱，不用多充。</span>
          </div>
        </div>

        <div className="hn-ttl">牵豆能干什么</div>
        <div className="hn-pad">
          <div className="hn-glass" style={{ overflow: 'hidden' }}>
            <div className="hn-lg"><span className="hn-sq"><Ic n="video" s={17} /></span><div className="hn-grow" style={{ fontSize: 14 }}>视频见面<span className="hn-t3" style={{ marginLeft: 6 }}>男方付</span></div><span className="hn-t2 hn-num">{videoPerMin > 0 ? `${w?.videoPerMin} / 分钟` : '不收'}</span></div>
            <div className="hn-lg top"><span className="hn-sq"><Ic n="spark" s={17} /></span><div className="hn-grow" style={{ fontSize: 14 }}>AI 深聊、推荐理由</div><span className="hn-t2">按实际用量</span></div>
            <div className="hn-lg top"><span className="hn-sq"><Ic n="shield" s={17} /></span><div className="hn-grow" style={{ fontSize: 14 }}>真人认证</div><span className="hn-t2 hn-num">1 / 次</span></div>
          </div>
        </div>

        {/* 这里原来有「怎么付：微信支付 / 支付宝」两行，2026-11-27 拿掉了（样稿 10-qiandou 里没有）：
            这一页在 iOS 的 App 里也会打开，iOS 上只能用苹果内购，不能出现别的收款方式。收款接好以后按平台各放各的。 */}
        <div className="hn-pad" style={{ marginTop: 18 }}><button className="hn-btn" disabled={!can}>支付 ¥{amount.toFixed(2)}</button></div>
        <div className="hn-t3" style={{ textAlign: 'center', marginTop: 10, padding: '0 20px', lineHeight: 1.6 }}>牵豆只能在一线牵里使用，不能提现、不能转给别人，不会过期</div>
      </div>
    </div>
  );
}

/** 我自己的 Key：没填时是填写页，填好后是状态 + 管理 */
export function AiKeyPage() {
  const nav = useNavigate();
  const back = useBack();
  const [w, setW, reload] = useWallet();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  /** 已经有 Key，但用户点了「换一个」 */
  const [replacing, setReplacing] = useState(false);
  const [toast, showToast] = useToast();

  const run = async (fn: () => Promise<AiWalletView>, okMsg?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      setW(await fn());
      if (okMsg) showToast(okMsg);
    } catch (e) {
      showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(async () => {
    const r = await api<AiWalletView>('/ai-wallet/key', { method: 'POST', body: { key: key.trim() } });
    setKey('');
    setReplacing(false);
    return r;
  }, 'Key 可用，已保存');

  const paste = async () => {
    try {
      setKey((await navigator.clipboard.readText()).trim());
    } catch {
      showToast('读不到剪贴板，请长按输入框粘贴');
    }
  };

  const filled = !!w?.key && !replacing;

  return (
    <div className="hn-page">
      <Nav title="我自己的 Key" onBack={() => (replacing ? setReplacing(false) : back())} />
      <div className="hn-scroll" style={{ paddingBottom: 30 }}>
        {w && !filled && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '22px 30px 0', textAlign: 'center' }}>
              <div className="hn-orb lg"><Ic n="key" s={26} /></div>
              <div style={{ fontSize: 20, fontWeight: 800, marginTop: 24 }}>用我自己的 DeepSeek Key</div>
              <div className="hn-t2" style={{ marginTop: 8, lineHeight: 1.6 }}>AI 功能用你自己在 DeepSeek 的额度，<br />平台不扣你的牵豆，也不收手续费</div>
            </div>
            <div className="hn-pad" style={{ marginTop: 20 }}>
              <div className="hn-field">
                <Ic n="key" s={16} />
                <input value={key} placeholder="把 sk- 开头的 Key 粘贴到这里" autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
                <button className="hn-pill ghost" style={{ height: 36, borderRadius: 14, background: 'var(--hn-soft)', color: 'var(--hn-rose)', boxShadow: 'none' }} onClick={paste}><Ic n="clip" s={13} />粘贴</button>
              </div>
              <button className="hn-btn" style={{ marginTop: 14 }} disabled={busy || key.trim().length < 10} onClick={save}>{busy ? '正在测试…' : '测试并保存'}</button>
            </div>
            <div className="hn-ttl">怎么拿到 Key</div>
            <div className="hn-pad">
              <div className="hn-glass" style={{ padding: 14, fontSize: 13.5, lineHeight: 1.6 }}>
                <div className="hn-row" style={{ alignItems: 'flex-start' }}><span className="hn-stepn">1</span><span>打开 <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer" style={{ color: 'var(--hn-rose)' }}>platform.deepseek.com</a>，用手机号注册</span></div>
                <div className="hn-row" style={{ alignItems: 'flex-start', marginTop: 9 }}><span className="hn-stepn">2</span><span>在那边充一点钱，几块钱够用很久</span></div>
                <div className="hn-row" style={{ alignItems: 'flex-start', marginTop: 9 }}><span className="hn-stepn">3</span><span>点「API Keys」→「创建」，把那一串复制回来</span></div>
              </div>
            </div>
            <div className="hn-row" style={{ padding: '14px 24px 0', alignItems: 'flex-start', gap: 7 }}>
              <Ic n="shield" s={14} style={{ color: 'var(--hn-rose)', marginTop: 2 }} />
              <span className="hn-t3" style={{ fontSize: 11.5, lineHeight: 1.6 }}>Key 加密保存在服务器，只用来替你调用 AI；页面上只显示最后 4 位，随时能删。</span>
            </div>
          </>
        )}

        {w && filled && (
          <>
            <div className="hn-pad" style={{ marginTop: 6 }}>
              <div className="hn-glass" style={{ padding: 16 }}>
                <div className="hn-row">
                  <span className="hn-sq ok lg"><Ic n="check" s={22} /></span>
                  <div className="hn-grow">
                    <div style={{ fontSize: 17, fontWeight: 800 }}>Key 已保存</div>
                    <div className="hn-t2 hn-num" style={{ marginTop: 3, fontSize: 12.5 }}>sk-············{w.key!.tail}{w.key!.checkedAt ? ` · ${fmtTime(w.key!.checkedAt)} 测试通过` : ''}</div>
                  </div>
                </div>
                <div className="hn-row" style={{ marginTop: 14 }}>
                  <button className="hn-pill ghost" style={{ height: 36, borderRadius: 18 }} disabled={busy} onClick={() => run(() => api<AiWalletView>('/ai-wallet/key/test', { method: 'POST' }), 'Key 可用')}><Ic n="refresh" s={13} />重新测试</button>
                  <button className="hn-pill ghost" style={{ height: 36, borderRadius: 18 }} onClick={() => setReplacing(true)}><Ic n="pencil" s={13} />换一个 Key</button>
                </div>
              </div>
            </div>

            <div className="hn-ttl">现在用哪种方式付</div>
            <div className="hn-pad">
              <PayOptions wallet={payView(w)} onPick={(payMode) => run(() => api<AiWalletView>('/ai-wallet/mode', { method: 'PUT', body: { payMode } }))} onGoKey={() => {}} />
            </div>

            <div className="hn-ttl">Key 出问题的时候</div>
            <div className="hn-pad">
              <div className="hn-glass">
                <div className="hn-lr" style={{ padding: '13px 14px' }} onClick={() => run(() => api<AiWalletView>('/ai-wallet/auto-fallback', { method: 'PUT', body: { on: !w.autoFallback } }))}>
                  <div className="hn-grow"><div>自动改用牵豆</div><div className="hn-t3" style={{ marginTop: 3, lineHeight: 1.5 }}>{w.autoFallback ? '开着：Key 用不了时直接用牵豆接着聊，并提示你一句' : '关着：先停下来问你，不会悄悄扣牵豆'}</div></div>
                  <span className={`hn-switch${w.autoFallback ? ' on' : ''}`} />
                </div>
              </div>
            </div>
            <div className="hn-pad" style={{ marginTop: 14 }}>
              <div className="hn-glass">
                <div className="hn-lr" style={{ color: '#f04438', justifyContent: 'center', fontWeight: 600 }} onClick={() => window.confirm('删除后，AI 功能改回用牵豆。确定删除吗？') && run(() => api<AiWalletView>('/ai-wallet/key', { method: 'DELETE' }), '已删除')}><Ic n="trash" s={15} />删除这个 Key</div>
              </div>
            </div>
            <div className="hn-t3" style={{ textAlign: 'center', marginTop: 12, lineHeight: 1.6, padding: '0 30px' }}>用自己的 Key 花了多少，以 DeepSeek 后台为准</div>
          </>
        )}
        {!w && <div className="hn-t2" style={{ textAlign: 'center', padding: 60 }} onClick={() => void reload()}>加载中…</div>}
      </div>
      {toast}
    </div>
  );
}
