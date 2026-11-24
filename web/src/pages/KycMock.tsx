import { useNavigate, useSearchParams } from 'react-router-dom';

/**
 * 测试用的「刷脸」页（后端 KYC_PROVIDER=mock 时用）。真人认证和刷脸找回都会到这里。
 * 真实刷脸是阿里云实人认证的页面，不是这个。
 * 点「模拟完成刷脸」→ 进结果页 /kyc-result（和真实刷脸跳回来以后走的是同一页，由它去问服务器结果）。
 */
export function KycMockPage() {
  const nav = useNavigate();
  const certifyId = useSearchParams()[0].get('c') || '';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0e0c11', color: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ marginTop: 'calc(40px + env(safe-area-inset-top))', fontSize: 16, fontWeight: 700 }}>实人认证</div>
      <div style={{ width: 210, height: 270, marginTop: 40, borderRadius: '50% / 46%', border: '3px dashed rgba(255,255,255,.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
        <div style={{ fontSize: 120, lineHeight: 1, opacity: 0.5, marginBottom: 10 }}>🧑</div>
      </div>
      <div style={{ marginTop: 26, fontWeight: 700, fontSize: 16 }}>请把脸对准框内</div>
      <div style={{ marginTop: 6, opacity: 0.65, fontSize: 12.5, textAlign: 'center', padding: '0 30px' }}>测试环境：点下面的按钮模拟刷脸完成（真实刷脸是阿里云的页面）</div>
      <div style={{ marginTop: 'auto', width: '100%', maxWidth: 440, padding: '0 24px calc(26px + env(safe-area-inset-bottom))' }}>
        <button className="hn-btn" disabled={!certifyId} onClick={() => nav(`/kyc-result?c=${encodeURIComponent(certifyId)}`, { replace: true })}>模拟完成刷脸</button>
        <div style={{ textAlign: 'center', marginTop: 12, opacity: 0.5, fontSize: 12 }}>认证由阿里云实人认证提供（测试期为模拟）</div>
      </div>
    </div>
  );
}
