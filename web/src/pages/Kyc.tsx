import { CSSProperties, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, reasonOf } from '../api';
import { Ic, Nav, Orb, useBack, useToast } from '../hn';
import { saveKycPending } from './KycResult';

interface KycStatus {
  realname: boolean;
  required: boolean;
  feeYuan: string;
  feeMicro: number;
  balanceYuan: string;
  balanceMicro: number;
  provider: string;
}

/**
 * 实人认证（身份证 + 刷脸，一次完成）。并进基础画像的最后一步。
 * ¥1 从 AI 余额扣（成本价不加价），通过才扣；只存是否通过和证号哈希，不存证号明文、不存人脸照片。
 * 样稿：design/04-kyc.html。网址带 ?next=要返回的路径（认证完回那里）。
 */
export function KycPage() {
  const nav = useNavigate();
  const back = useBack();
  const next = useSearchParams()[0].get('next') || '/me';
  const [st, setSt] = useState<KycStatus | null>(null);
  const [name, setName] = useState('');
  const [idNo, setIdNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => { api<KycStatus>('/kyc/status').then(setSt).catch((e) => showToast((e as Error).message)); }, []);
  // 从阿里云刷脸页按返回键回来（浏览器直接恢复这一页）：把按钮从「处理中…」恢复成可点
  useEffect(() => {
    const on = () => setBusy(false);
    window.addEventListener('pageshow', on);
    return () => window.removeEventListener('pageshow', on);
  }, []);

  const start = async () => {
    if (busy || !st) return;
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(name.trim())) return showToast('请输入正确的真实姓名');
    if (!/^\d{17}[\dX]$/.test(idNo.trim())) return showToast('请输入 18 位身份证号');
    setBusy(true);
    try {
      // 真实刷脸（阿里云）：先取浏览器环境参数，阿里云靠它决定给哪种刷脸页；mock 不需要
      const metaInfo = st.provider === 'aliyun' ? await aliyunMetaInfo() : undefined;
      const r = await api<{ certifyId: string; url: string; provider: string }>(
        '/kyc/start',
        { method: 'POST', body: { name: name.trim(), idNo: idNo.trim(), metaInfo } },
      );
      // 记下这次认证（刷完回来靠它知道查哪一次、查完回哪）
      saveKycPending(r.certifyId, next);
      // mock：打开本地模拟刷脸页，点完进结果页
      if (r.provider === 'mock') return nav(`/kyc-mock?c=${encodeURIComponent(r.certifyId)}`);
      // aliyun：整页跳到阿里云的刷脸页；刷完阿里云跳回 /kyc-return.html → /kyc-result
      window.location.href = r.url;
    } catch (e) {
      const reason = reasonOf(e);
      if (reason === 'no_balance') {
        if (window.confirm(`AI 余额不足，实人认证需要 ¥${st.feeYuan}。现在去充值？`)) nav('/ai-fee/topup');
      } else showToast((e as Error).message);
      setBusy(false);
    }
  };

  if (!st) {
    return (
      <div className="hn-page"><Nav title="实人认证" onBack={back} />
        <div className="hn-t2" style={{ textAlign: 'center', padding: 60 }}>加载中…</div>{toast}
      </div>
    );
  }

  if (st.realname) {
    return (
      <div className="hn-page"><Nav title="实人认证" onBack={back} />
        <div style={{ textAlign: 'center', padding: '50px 30px 0' }}>
          <div style={okRing}><Ic n="check" s={46} /></div>
          <div style={{ fontSize: 22, fontWeight: 800, marginTop: 22 }}>已完成真人认证</div>
          <div className="hn-t2" style={{ marginTop: 8, lineHeight: 1.6 }}>你的身份已经过平台核验，<br />画像上会显示「真人认证」标。</div>
        </div>
        {toast}
      </div>
    );
  }

  const afterYuan = ((st.balanceMicro - st.feeMicro) / 1_000_000).toFixed(2);
  const enough = st.balanceMicro >= st.feeMicro;

  return (
    <div className="hn-page">
      <Nav title="实人认证" onBack={back} />
      <div className="hn-scroll" style={{ padding: '6px 16px 20px' }}>
        <div style={{ textAlign: 'center', padding: '10px 0 2px' }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}><Orb size="lg" /></div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 16 }}>实人认证</div>
          <div className="hn-t2" style={{ marginTop: 6 }}>身份证 + 刷脸，一次完成</div>
        </div>

        <div className="hn-glass" style={{ borderRadius: 20, padding: '2px 14px 12px', marginTop: 16 }}>
          <Feat ic="shield" title="确认是你本人、已满 18 岁" sub="防骗子、防未成年，相亲更安心" />
          <Feat ic="lock" title="只存「是否通过」" sub="不保存身份证号明文，不保存人脸照片" />
          <Feat ic="wallet" title={`本次 ¥${st.feeYuan}，从 AI 余额扣`} sub="按成本价，平台不加价；认证不通过不扣" />
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="hn-t3" style={{ marginBottom: 6 }}>真实姓名</div>
          <div className="hn-field"><input value={name} maxLength={20} placeholder="与身份证一致" onChange={(e) => setName(e.target.value)} /></div>
          <div className="hn-t3" style={{ margin: '12px 0 6px' }}>身份证号</div>
          <div className="hn-field"><input value={idNo} maxLength={18} inputMode="numeric" placeholder="18 位身份证号码" onChange={(e) => setIdNo(e.target.value.replace(/[^0-9Xx]/g, '').toUpperCase().slice(0, 18))} /></div>
        </div>

        <div className="hn-row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <span className="hn-t2 hn-num"><Ic n="wallet" s={14} style={{ verticalAlign: '-2px', marginRight: 4 }} />AI 余额 ¥{st.balanceYuan}</span>
          <span className="hn-t3 hn-num">{enough ? `认证后剩 ¥${afterYuan}` : '余额不足'}</span>
        </div>
      </div>

      <div style={{ padding: '10px 16px calc(14px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--hn-line)', background: 'var(--hn-cream)' }}>
        {enough
          ? <button className="hn-btn" disabled={busy} onClick={start}><Ic n="camera" s={18} />{busy ? '处理中…' : '开始刷脸认证'}</button>
          : <button className="hn-btn" onClick={() => nav('/ai-fee/topup')}>余额不足，去充值</button>}
        <div className="hn-t3" style={{ textAlign: 'center', marginTop: 8 }}>点「开始」即同意把姓名、身份证号交给认证服务商核验</div>
      </div>
      {toast}
    </div>
  );
}

/** 阿里云实人认证的浏览器环境参数：加载它的脚本（只加载一次），调 getMetaInfo()。每次发起都要现取，不能缓存、不能写死。 */
const ALIYUN_META_JS = 'https://o.alicdn.com/yd-cloudauth/cloudauth-cdn/jsvm_all.js';
let metaJsLoading: Promise<void> | null = null;

export async function aliyunMetaInfo(): Promise<string> {
  const w = window as unknown as { getMetaInfo?: () => unknown };
  if (typeof w.getMetaInfo !== 'function') {
    metaJsLoading ??= new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ALIYUN_META_JS;
      s.onload = () => resolve();
      s.onerror = () => { metaJsLoading = null; s.remove(); reject(new Error('刷脸组件加载失败，请检查网络后重试')); };
      document.head.appendChild(s);
    });
    await metaJsLoading;
  }
  if (typeof w.getMetaInfo !== 'function') throw new Error('刷脸组件加载失败，请刷新页面后重试');
  return JSON.stringify(w.getMetaInfo());
}

function Feat({ ic, title, sub }: { ic: string; title: string; sub: string }) {
  return (
    <div className="hn-row" style={{ gap: 12, alignItems: 'flex-start', marginTop: 12 }}>
      <span className="hn-sq" style={{ flexShrink: 0 }}><Ic n={ic} s={18} /></span>
      <div><div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div><div className="hn-t3" style={{ marginTop: 3, lineHeight: 1.5 }}>{sub}</div></div>
    </div>
  );
}

const okRing: CSSProperties = {
  width: 92, height: 92, borderRadius: 46, margin: '0 auto',
  background: '#e3f7ec', color: '#12b76a', display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 0 0 10px rgba(18,183,106,.08)',
};
