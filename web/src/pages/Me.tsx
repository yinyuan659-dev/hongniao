import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { useApp } from '../store';
import { ScanFlow } from './ChatList';
import { ScanIcon } from '../components/QrScanner';
import { SYSTEM, langChoice, languages, setLang, t } from '../i18n';
import { Ic } from '../hn';
import { FLASH_KEY } from './KycResult';

/** 画像卡片上深聊按钮的字 */
const DEEP_LABEL = { none: '和 AI 红娘深聊', chatting: '继续聊', draft: '去确认画像', done: '再聊聊' } as const;

export function MePage() {
  const nav = useNavigate();
  const { user, setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(user);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState(false);

  /** AI 余额（元）；null = 还没取到 */
  const [balance, setBalance] = useState<string | null>(null);
  /** 实人认证：后台要求且还没认证时，画像卡片下提示一下 */
  const [kyc, setKyc] = useState<{ required: boolean; realname: boolean } | null>(null);
  /** 能登录这个账号的设备有几台；null = 还没取到 */
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  /** 并号后回到原来的账号时的一次性提示 */
  const [flash, setFlash] = useState('');

  useEffect(() => {
    api<UserProfile>('/user/me').then((u) => {
      setMe(u);
      setUser(u);
    }).catch(() => {});
    api<{ balance: string }>('/ai-wallet').then((w) => setBalance(w.balance)).catch(() => {});
    api<{ required: boolean; realname: boolean }>('/kyc/status').then(setKyc).catch(() => {});
    api<{ devices: unknown[] }>('/devices').then((r) => setDeviceCount(r.devices.length)).catch(() => {});
    // 并号后回到原来的账号：顶上提示一次
    try {
      const f = sessionStorage.getItem(FLASH_KEY);
      if (f) { setFlash(f); sessionStorage.removeItem(FLASH_KEY); }
    } catch { /* 提示出不来不影响 */ }
  }, []);

  const toggleVideo = async () => {
    if (!me) return;
    try {
      const u = await api<UserProfile>('/user/me', { method: 'PUT', body: { allowVideo: !me.allowVideo } });
      setMe({ ...me, allowVideo: u.allowVideo });
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (!me) return <div className="empty">{t('common.loading')}</div>;
  const deep = me.deepStatus ?? 'none';
  // 完成度：只做完点选问答 62%，深聊也确认了 100%
  const percent = deep === 'done' ? 100 : deep === 'draft' ? 90 : deep === 'chatting' ? 75 : 62;
  const choice = langChoice();
  const langName = choice === SYSTEM ? t('lang.system') : languages.find((l) => l.code === choice)?.name ?? choice;

  return (
    // 头部（头像到相亲资料卡）固定不动，下面的功能分组单独滚动
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 顶部渐变背景 */}
      <div style={{ background: 'linear-gradient(180deg, rgba(254,44,85,0.14), transparent 85%)', padding: '28px 20px 0', flexShrink: 0 }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 76, height: 76, border: '2px solid rgba(0,0,0,0.08)' }}>
            {me.avatar ? <img src={me.avatar} alt="" /> : null}
          </div>
          <div className="grow" style={{ paddingTop: 4 }}>
            <div style={{ fontSize: 21, fontWeight: 700 }}>{me.nickname}</div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <span style={{
                padding: '2px 10px', borderRadius: 10, fontSize: 11,
                background: me.gender === 1 ? 'rgba(64,156,255,0.18)' : 'rgba(254,44,85,0.18)',
                color: me.gender === 1 ? '#6db3ff' : '#ff7a95',
              }}>
                {me.gender === 1 ? t('me.male') : t('me.female')} {me.age}
              </span>
              {me.isGuide && <span className="tag tag-accent">{t('me.verified')}</span>}
              {me.cityName && <span className="tag tag-muted">{me.cityName}</span>}
            </div>
            {me.shortId && (
              <div
                className="small"
                style={{ marginTop: 6, cursor: 'pointer' }}
                onClick={() => navigator.clipboard?.writeText(me.shortId!)}
              >
                {t('me.idCopy', { id: me.shortId })}
              </div>
            )}
          </div>
          {/* 扫一扫（邀请名片） */}
          <div
            title={t('me.scan')}
            onClick={() => setScanning(true)}
            style={{
              width: 38, height: 38, borderRadius: 19, flexShrink: 0, marginTop: 4,
              background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ScanIcon />
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.6 }}>
          {me.signature || t('me.noSignatureHint')}
        </div>

        {/* 关注 / 粉丝 */}
        <div className="row" style={{ gap: 26, marginTop: 16 }}>
          <span style={{ fontSize: 13 }} className="muted">
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.following ?? 0}</b>{t('me.following')}
          </span>
          <span style={{ fontSize: 13 }} className="muted">
            <b style={{ fontSize: 17, color: 'var(--text)', marginRight: 4 }}>{me.fans ?? 0}</b>{t('me.fans')}
          </span>
        </div>

        {flash && (
          <div onClick={() => setFlash('')} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginTop: 14, padding: '11px 14px', borderRadius: 16, fontSize: 12.5, lineHeight: 1.6, background: '#e9f8ef', border: '1px solid #c9efd9', color: '#1d6b45' }}>
            <Ic n="check" s={15} style={{ color: '#12b76a', marginTop: 2, flexShrink: 0 }} /><span>{flash}</span>
          </div>
        )}

        {/* 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能主动找人聊天 */}
        <div className="hn-hero-card" style={{ margin: '16px 0 18px' }}>
          <div className="hn-row">
            <div className="hn-grow">
              <div style={{ fontSize: 18, fontWeight: 800 }}>我的相亲画像</div>
              <div style={{ fontSize: 12.5, opacity: 0.92, marginTop: 6, lineHeight: 1.6 }}>
                {!me.profileDone ? <>基本情况还没填完<br />填完才能主动找人聊天</>
                  : deep === 'done' ? <>基本情况和 AI 深聊都完成了<br />想法变了可以再聊聊</>
                    : deep === 'draft' ? <>AI 红娘整理好了画像<br />等你看一眼、点确认</>
                      : deep === 'chatting' ? <>基本情况已完成<br />和 AI 红娘聊到一半</>
                        : <>基本情况已完成<br />再和 AI 红娘聊聊，推荐更准</>}
              </div>
            </div>
            {me.profileDone && (
              <div className="hn-ring" style={{ background: `conic-gradient(#fff 0 ${percent}%, rgba(255,255,255,.28) ${percent}% 100%)` }}><span>{percent}%</span></div>
            )}
          </div>
          <div className="hn-row" style={{ marginTop: 14 }}>
            {me.profileDone
              ? <>
                <button className="hn-pill w" onClick={() => nav('/card/me')}>查看画像 <Ic n="right" s={14} /></button>
                <button className="hn-pill g" onClick={() => nav('/deep')}><Ic n="spark" s={14} />{DEEP_LABEL[deep]}</button>
              </>
              : <button className="hn-pill w" onClick={() => nav('/interview')}>继续填写 <Ic n="right" s={14} /></button>}
          </div>
        </div>

        {/* 实人认证：后台要求且还没认证时，提示去完成（做过才能聊天 / 发动态 / 评论） */}
        {kyc?.required && !kyc.realname && (
          <div className="hn-glass" style={{ borderRadius: 16, padding: '12px 14px', margin: '0 0 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="hn-sq" style={{ flexShrink: 0 }}><Ic n="shield" s={18} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>完成实人认证</div>
              <div className="hn-t3" style={{ marginTop: 2, lineHeight: 1.5 }}>做过才能聊天、发动态、评论 · ¥1</div>
            </div>
            <button className="hn-pill" onClick={() => nav('/kyc?next=/me')}>去认证 <Ic n="right" s={14} /></button>
          </div>
        )}
      </div>

      {/* 功能分组：我的内容 / 工具 / 设置 */}
      <div className="me-groups no-scrollbar">
        <div className="me-group-title">{t('me.group.content')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/my-moments')}>{t('me.myMoments')}</div>
        </div>
        {/* AI 费用：深聊这类 AI 功能按用量花模型费（平台余额或自己的 Key） */}
        <div className="me-group-title">AI 费用</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/ai-fee')}>
            <span style={{ flex: 1 }}>AI 余额</span>
            <span className="muted" style={{ fontSize: 14, marginRight: 6 }}>{balance === null ? '' : `¥${balance}`}</span>
          </div>
        </div>
        {/* 账号与安全：能登录这个账号的设备（换手机刷脸找回后会多出来），可以移除 */}
        <div className="me-group-title">账号与安全</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/devices')}>
            <span style={{ flex: 1 }}>登录设备</span>
            <span className="muted" style={{ fontSize: 14, marginRight: 6 }}>{deviceCount === null ? '' : `${deviceCount} 台`}</span>
          </div>
        </div>
        <div className="me-group-title">{t('me.group.tools')}</div>
        <div className="me-group">
          <div className="list-row" onClick={() => nav('/invite-card')}>{t('me.inviteCard')}</div>
        </div>
        <div className="me-group-title">{t('me.group.settings')}</div>
        <div className="me-group">
          {/* 编辑资料 = 进 AI 红娘的资料收集；头像 / 昵称 / 照片墙单独一行 */}
          <div className="list-row" onClick={() => nav('/interview')}>{t('me.editProfile')}</div>
          <div className="list-row" onClick={() => nav('/edit-profile')}>{t('hn.basic')}</div>
          {/* 视频见面：默认关，自己和对方都打开才能互相发起视频通话 */}
          <div className="list-row no-arrow" onClick={toggleVideo}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block' }}>{t('me.videoMeet')}</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{t('me.videoMeetSub')}</span>
            </span>
            <span className={`switch${me.allowVideo ? ' on' : ''}`} />
          </div>
          <div className="list-row" onClick={() => setPicking(true)}>
            <span style={{ flex: 1 }}>{t('lang.title')}</span>
            <span className="muted" style={{ fontSize: 14, marginRight: 6 }}>{langName}</span>
          </div>
        </div>
      </div>

      {/* 扫一扫：邀请名片 → 私聊 */}
      {scanning && <ScanFlow onClose={() => setScanning(false)} />}

      {/* 语言：跟随系统 + 打包进来的每种语言（名字用各自的语言写） */}
      {picking && (
        <div className="mask" onClick={() => setPicking(false)}>
          <div className="card" style={{ width: 280, padding: '8px 0' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 20px', fontSize: 16, fontWeight: 600 }}>{t('lang.title')}</div>
            {[{ code: SYSTEM, name: t('lang.system') }, ...languages].map((l) => (
              <div key={l.code} style={{ display: 'flex', padding: '14px 20px', fontSize: 15, cursor: 'pointer' }} onClick={() => (l.code === choice ? setPicking(false) : setLang(l.code))}>
                <span style={{ flex: 1 }}>{l.name}</span>
                {l.code === choice && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>✓</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
