import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, loginDeviceId, reasonOf } from '../api';
import { hnNative } from '../bridge';
import { Ic, Nav, Orb, useToast } from '../hn';
import { aliyunMetaInfo } from './Kyc';
import { saveKycPending } from './KycResult';

/**
 * 换了手机 / 换了浏览器：用「身份证 + 刷脸」找回原来的账号（/recover，不用登录）。样稿 design/05-recover.html。
 * 只有做过真人认证的账号能这样找回。先查这张身份证有没有认证过的账号：
 *   没有 → 不刷脸、不花钱，显示「没有找到账号」；
 *   有 → 跳到刷脸页（和真人认证是同一个页面），刷完回到 /kyc-result，通过就登录原来的账号。
 * 这一步不显示账号的任何信息，刷脸通过以后才显示。
 */
export function RecoverPage() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [idNo, setIdNo] = useState('');
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [toast, showToast] = useToast();

  // 从刷脸页按返回键回来：把按钮从「处理中…」恢复成可点
  useEffect(() => {
    const on = () => setBusy(false);
    window.addEventListener('pageshow', on);
    return () => window.removeEventListener('pageshow', on);
  }, []);

  // 在 App 里是原生注册页打开的内嵌网页：返回 = 关掉网页回注册页
  const back = () => { if (!hnNative('close')) nav('/register', { replace: true }); };

  const submit = async () => {
    if (busy) return;
    if (!/^[\u4e00-\u9fa5·]{2,20}$/.test(name.trim())) return showToast('请输入正确的真实姓名');
    if (!/^\d{17}[\dX]$/.test(idNo.trim())) return showToast('请输入 18 位身份证号');
    setBusy(true);
    try {
      // 真实刷脸要用的浏览器环境参数。取不到先不带（测试期的模拟刷脸用不着；真实刷脸服务器会提示重试）
      const metaInfo = await Promise.race([
        aliyunMetaInfo().catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 6000)),
      ]);
      const r = await api<{ found: boolean; certifyId?: string; url?: string; provider?: string }>(
        '/recover/start',
        { method: 'POST', body: { deviceId: loginDeviceId(), name: name.trim(), idNo: idNo.trim(), metaInfo } },
      );
      if (!r.found || !r.certifyId) {
        setNotFound(true);
        setBusy(false);
        return;
      }
      saveKycPending(r.certifyId, '/plaza', 'recover');
      if (r.provider === 'mock') return nav(`/kyc-mock?c=${encodeURIComponent(r.certifyId)}`);
      window.location.href = r.url!;
    } catch (e) {
      // 这台设备上已经登录着一个号：回首页（在那个号里做真人认证会走并号）
      if (reasonOf(e) === 'device_in_use') {
        window.alert((e as Error).message);
        if (!hnNative('close')) nav('/', { replace: true });
      } else showToast((e as Error).message);
      setBusy(false);
    }
  };

  if (notFound) {
    return (
      <div className="hn-page">
        <Nav title="找回账号" onBack={() => setNotFound(false)} />
        <div className="hn-scroll">
          <div style={{ padding: '44px 28px 0', textAlign: 'center' }}>
            <div style={{ width: 92, height: 92, borderRadius: 46, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff1e0', color: '#f08c00', boxShadow: '0 0 0 10px rgba(240,140,0,.08)' }}><Ic n="info" s={46} /></div>
            <div style={{ fontSize: 21, fontWeight: 800, marginTop: 22 }}>没有找到账号</div>
            <div className="hn-t2" style={{ marginTop: 10, lineHeight: 1.7 }}>这张身份证没有做过真人认证的账号。<br />请核对姓名和证号有没有填错。</div>
          </div>
          <div style={{ padding: '22px 20px 0' }}>
            <div className="hn-glass" style={tip}><Ic n="info" s={15} style={tipIc} /><span>以前的账号如果没做过真人认证，换了手机就找不回了，只能重新注册。原来那台手机还能打开的话，先在那台手机上做完真人认证，再回来找回。</span></div>
          </div>
        </div>
        <div style={dock}>
          <button className="hn-btn" onClick={() => setNotFound(false)}>重新填写</button>
          <button className="hn-btn ghost" style={{ marginTop: 10 }} onClick={back}>注册新账号</button>
        </div>
        {toast}
      </div>
    );
  }

  return (
    <div className="hn-page">
      <Nav title="找回账号" onBack={back} />
      <div className="hn-scroll" style={{ padding: '6px 20px 20px' }}>
        <div style={{ textAlign: 'center', paddingTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}><Orb size="lg" /></div>
          <div style={{ fontSize: 20, fontWeight: 800, marginTop: 14 }}>用身份证 + 刷脸找回</div>
          <div className="hn-t2" style={{ marginTop: 6 }}>只有做过真人认证的账号能这样找回</div>
        </div>
        <div className="hn-t3" style={{ margin: '20px 4px 6px' }}>真实姓名</div>
        <div className="hn-field"><input value={name} maxLength={20} placeholder="与身份证一致" onChange={(e) => setName(e.target.value)} /></div>
        <div className="hn-t3" style={{ margin: '14px 4px 6px' }}>身份证号</div>
        <div className="hn-field"><input value={idNo} maxLength={18} inputMode="numeric" placeholder="18 位身份证号码" onChange={(e) => setIdNo(e.target.value.replace(/[^0-9Xx]/g, '').toUpperCase().slice(0, 18))} /></div>
        <div className="hn-glass" style={{ ...tip, marginTop: 16 }}><Ic n="lock" s={15} style={tipIc} /><span>先查这张身份证有没有认证过的账号。有，就刷脸确认是你本人；没有，就不用刷。我们不保存你填的证号。</span></div>
      </div>
      <div style={dock}>
        <button className="hn-btn" disabled={busy} onClick={submit}>{busy ? '处理中…' : '下一步'}</button>
        <div className="hn-t3" style={{ textAlign: 'center', marginTop: 8 }}>点「下一步」即同意把姓名、身份证号交给认证服务商核验</div>
      </div>
      {toast}
    </div>
  );
}

const tip = { display: 'flex', gap: 9, alignItems: 'flex-start', padding: '11px 14px', borderRadius: 16, fontSize: 12.5, lineHeight: 1.6, color: 'var(--hn-ink2)' } as const;
const tipIc = { color: 'var(--hn-rose)', marginTop: 2, flexShrink: 0 } as const;
const dock = { padding: '10px 16px calc(14px + env(safe-area-inset-bottom))', flexShrink: 0 } as const;
