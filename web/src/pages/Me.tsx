import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { useApp } from '../store';
import { wsManager } from '../ws';
import { ScanFlow } from './ChatList';
import { ScanIcon } from '../components/QrScanner';
import { SYSTEM, langChoice, languages, setLang, t } from '../i18n';
import { Ic } from '../hn';
import { FLASH_KEY } from './KycResult';

/** 画像卡片上深聊按钮的字 */
const DEEP_LABEL = { none: '和 AI 红娘深聊', chatting: '继续聊', draft: '去确认画像', done: '再聊聊' } as const;

/** 大标题滚出去多少像素以后，顶栏变成半透明的一条、中间出现小标题 */
const COLLAPSE_AT = 44;

/**
 * 把一段文字复制到剪贴板，成功返回 true。
 * 浏览器只在 https 页面上提供 navigator.clipboard；现在测试环境是 http，所以再用老办法（选中一个看不见的输入框再复制）兜一次。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 往下走老办法 */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 分组里的一行：彩色小图标 + 名字 + 右边的东西（值和箭头 / 开关） */
function Cell({ icon, color, title, onClick, children }: { icon: string; color: string; title: string; onClick: () => void; children?: ReactNode }) {
  return (
    <div className="me-cell" onClick={onClick}>
      <span className="me-ico" style={{ background: color }}><Ic n={icon} s={17} /></span>
      <span className="me-cell-title">{title}</span>
      {children}
    </div>
  );
}

/** 一行右边：（橙色小点）+ 灰色的值 + 箭头 */
function Val({ value, dot }: { value?: string; dot?: boolean }) {
  return (
    <span className="me-val">
      {dot && <span className="me-dot" />}
      {value}
      <Ic n="right" s={15} style={{ color: 'var(--text-3)' }} />
    </span>
  );
}

/**
 * 我的。
 *
 * 排法照 iOS 系统「设置」：整页一起滚（头像卡、相亲画像、各个分组都在同一个滚动区里），
 * 顶上是大标题「我的」，往上滑到大标题看不见时，顶栏中间出现小标题；每一行左边一个彩色小图标，右边灰色的值和箭头；
 * 开关的说明写在分组下面的小灰字里。样稿：design/06-me.html（用户 2026-11-25 确认）。
 */
export function MePage() {
  const nav = useNavigate();
  const { user, setUser } = useApp();
  const [me, setMe] = useState<UserProfile | null>(user);
  const [scanning, setScanning] = useState(false);
  const [picking, setPicking] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 牵豆余额；null = 还没取到 */
  const [balance, setBalance] = useState<string | null>(null);
  /** 实人认证：后台要求且还没认证时，「账号与安全」里多一行提示去完成 */
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
    // 平台把我设成领队 / 取消领队：服务器推过来，「领队后台」那一行当场出现 / 消失
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'trip' && frame.data?.event === 'leader') {
        const on = !!frame.data.on;
        setMe((m) => (m ? { ...m, isLeader: on } : m));
      }
    });
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
  const needKyc = !!kyc?.required && !kyc.realname;
  /**
   * 还没做真人认证：「账号与安全」里一直有「真人认证」这一行（2026-11-28 改的）。
   * 原来只有后台打开「必须先认证」时才有；开关关着的时候没认证的人找不到去认证的地方，而约旅行线路、刷脸找回账号都要认证过。
   * 后台要求的写「未完成」带橙点，不要求的写「未认证」。
   */
  const unverified = !!kyc && !kyc.realname;
  const real = kyc?.realname ?? me.realname;
  // 「女 27 · 成都」；没选城市就不写城市
  const about = `${me.gender === 1 ? t('me.male') : t('me.female')} ${me.age}${me.cityName ? ` · ${me.cityName}` : ''}`;

  const copyId = (e: { stopPropagation: () => void }) => {
    // 点 ID 这一小段是复制，不进「基本资料」
    e.stopPropagation();
    copyText(me.shortId!).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const noWrap: CSSProperties = { whiteSpace: 'nowrap' };

  return (
    <div className="me-page no-scrollbar" onScroll={(e) => setCollapsed(e.currentTarget.scrollTop > COLLAPSE_AT)}>
      {/* 顶栏：扫一扫一直在右上角；滑动以后变成半透明的一条，中间出现小标题 */}
      <div className={`me-top${collapsed ? ' on' : ''}`}>
        <span className="me-top-title">{t('tab.me')}</span>
        <span className="me-top-scan" title={t('me.scan')} onClick={() => setScanning(true)}>
          <ScanIcon size={21} color="var(--accent)" />
        </span>
      </div>
      <div className="me-lt">{t('tab.me')}</div>

      {flash && (
        <div onClick={() => setFlash('')} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', margin: '0 16px 12px', padding: '11px 14px', borderRadius: 12, fontSize: 12.5, lineHeight: 1.6, background: '#e9f8ef', border: '1px solid #c9efd9', color: '#1d6b45' }}>
          <Ic n="check" s={15} style={{ color: '#12b76a', marginTop: 2, flexShrink: 0 }} /><span>{flash}</span>
        </div>
      )}

      {/* 第一张卡：我是谁。点了进「基本资料」（头像、昵称、签名、照片）；下半部分是关注 / 粉丝 */}
      <div className="me-card">
        <div className="me-who" onClick={() => nav('/edit-profile')}>
          <div className="avatar" style={{ width: 62, height: 62 }}>
            {me.avatar ? <img src={me.avatar} alt="" /> : null}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="me-who-name">
              <span>{me.nickname}</span>
              {real && <span className="me-real">真人认证</span>}
            </div>
            <div className="me-who-sub">
              {about}
              {me.shortId && (
                <span onClick={copyId} style={{ cursor: 'pointer' }}>
                  {' · '}ID {me.shortId}{' '}
                  {copied ? <span style={{ color: 'var(--accent)' }}>{t('common.copied')}</span> : <Ic n="copy" s={12} style={{ verticalAlign: '-1px' }} />}
                </span>
              )}
            </div>
            <div className="me-who-sub" style={{ marginTop: 3 }}>{me.signature || t('me.noSignatureHint')}</div>
          </div>
          <Ic n="right" s={15} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
        </div>
        <div className="me-stats">
          <div><b>{me.following ?? 0}</b>{t('me.following')}</div>
          <div><b>{me.fans ?? 0}</b>{t('me.fans')}</div>
        </div>
      </div>

      {/* 我的相亲画像：基本情况（点选问答，必做）+ AI 深聊（可选）。没做完基本情况不能点喜欢、不会被推荐 */}
      <div className="hn-hero-card" style={{ margin: '16px 16px 0', borderRadius: 18 }}>
        <div className="hn-row">
          <div className="hn-grow">
            <div style={{ fontSize: 18, fontWeight: 800 }}>我的相亲画像</div>
            <div style={{ fontSize: 12.5, opacity: 0.92, marginTop: 6, lineHeight: 1.6 }}>
              {!me.profileDone ? <>基本情况还没填完<br />填完才能喜欢别人、被推荐</>
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
              <button className="hn-pill w" style={noWrap} onClick={() => nav('/card/me')}>查看画像 <Ic n="right" s={14} /></button>
              <button className="hn-pill g" style={noWrap} onClick={() => nav('/deep')}><Ic n="spark" s={14} />{DEEP_LABEL[deep]}</button>
            </>
            : <button className="hn-pill w" style={noWrap} onClick={() => nav('/interview')}>继续填写 <Ic n="right" s={14} /></button>}
        </div>
      </div>

      <div className="me-gh">{t('me.group.content')}</div>
      <div className="me-card">
        <Cell icon="image" color="#ff9500" title={t('me.myMoments')} onClick={() => nav('/my-moments')}><Val /></Cell>
      </div>

      {/* 牵豆（原来叫 AI 余额，1 元 = 1 牵豆）：视频见面、AI 功能、真人认证都从这里扣 */}
      <div className="me-gh">牵豆</div>
      <div className="me-card">
        <Cell icon="wallet" color="#34c759" title="我的牵豆" onClick={() => nav('/ai-fee')}><Val value={balance === null ? undefined : `${balance}`} /></Cell>
      </div>

      {/* 账号与安全：真人认证（还没做的人一直有这一行）、能登录这个账号的设备（换手机刷脸找回后会多出来，可以移除） */}
      <div className="me-gh">账号与安全</div>
      <div className="me-card">
        {unverified && <Cell icon="shield" color="#ff9500" title="真人认证" onClick={() => nav('/kyc?next=/me')}><Val value={needKyc ? '未完成' : '未认证'} dot={needKyc} /></Cell>}
        <Cell icon="lock" color="#007aff" title="登录设备" onClick={() => nav('/devices')}><Val value={deviceCount === null ? undefined : `${deviceCount} 台`} /></Cell>
      </div>
      {unverified && <div className="me-gf">{needKyc ? '做过真人认证才能发动态、评论、视频见面。' : '约旅行线路、换手机后刷脸找回账号，都要先做真人认证。'}认证一次 1 牵豆。</div>}

      <div className="me-gh">{t('me.group.tools')}</div>
      <div className="me-card">
        {/* 领队后台：只有平台设成领队的人有这一行（发布线路、看约单、改名额） */}
        {me.isLeader && <Cell icon="car" color="#ff3d63" title="领队后台" onClick={() => nav('/leader')}><Val /></Cell>}
        <Cell icon="link" color="#af52de" title={t('me.inviteCard')} onClick={() => nav('/invite-card')}><Val /></Cell>
      </div>

      <div className="me-gh">{t('me.group.settings')}</div>
      <div className="me-card">
        {/* 相亲资料 = AI 红娘的那页问答（头像 / 昵称 / 照片墙在最上面那张卡里改） */}
        <Cell icon="heart" color="var(--accent)" title="相亲资料" onClick={() => nav('/interview')}><Val value={me.profileDone ? '已填完' : '未填完'} /></Cell>
        {/* 视频见面：默认关，自己和对方都打开才能互相发起视频通话 */}
        <Cell icon="video" color="#5ac8fa" title={t('me.videoMeet')} onClick={toggleVideo}><span className={`switch${me.allowVideo ? ' on' : ''}`} /></Cell>
        <Cell icon="globe" color="#8e8e93" title={t('lang.title')} onClick={() => setPicking(true)}><Val value={langName} /></Cell>
      </div>
      {/* 开关的说明：写在这一组下面 */}
      <div className="me-gf">{t('me.videoMeet')}：{t('me.videoMeetSub')}</div>

      <div className="me-gh">{t('me.group.about')}</div>
      <div className="me-card">
        <Cell icon="doc" color="#8e8e93" title={t('agreement.web.userTitle')} onClick={() => nav('/agreement/user')}><Val /></Cell>
        <Cell icon="shield" color="#8e8e93" title={t('agreement.web.privacyTitle')} onClick={() => nav('/agreement/privacy')}><Val /></Cell>
      </div>
      <div className="me-ver">{t('app.name')}</div>

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
