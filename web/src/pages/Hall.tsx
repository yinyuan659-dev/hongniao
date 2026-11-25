import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, UserProfile } from '../api';
import { isOwnWebUrl, openNativeWeb } from '../bridge';
import { useApp } from '../store';
import { Ic, Nav } from '../hn';
import { lang, t } from '../i18n';

/**
 * 大厅：两块内容，直接写在这里，不走后台配置（样稿 design/07-hall.html，用户 2026-11-25 过关）。
 *   ① 活动「前 10 对结婚的新人送旅行」→ 活动页（现在是占位版，规则还没定）
 *   ② 「相亲物语」→ 全屏打开 /wuyu.html（程序在 src/wuyu/）
 * 大厅里有什么以发出去的这一版为准：要加别的活动就改这个文件、发新版本，不靠后台开关变出来。
 */

/** 活动卡右下角的小飞机（装饰） */
function Plane({ size }: { size: number }) {
  return (
    <svg className="hall-plane" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  );
}

/** 「相亲物语」的地址：我们自己网站上的 /wuyu.html。g = 自己的性别（1 男 2 女，路两边放的是异性），lang = 界面语言 */
function wuyuUrl(gender?: number): string {
  const u = new URL('wuyu.html', location.origin + location.pathname);
  u.searchParams.set('g', gender === 2 ? '2' : '1');
  u.searchParams.set('lang', lang());
  return u.toString();
}

/** 打开「相亲物语」：App 里交给原生的全屏网页（带标题栏和返回，竖屏）；浏览器里就在当前页打开，按返回回到大厅 */
function openWuyu(gender?: number) {
  const url = wuyuUrl(gender);
  if (!isOwnWebUrl(url)) return;
  if (openNativeWeb(url, t('hall.wuyu.name'), 'portrait')) return;
  location.href = url;
}

export function HallPage() {
  const nav = useNavigate();
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);

  // App 的内嵌大厅只带了登录身份、没拉用户资料；打开「相亲物语」要知道自己的性别，补一次
  useEffect(() => {
    if (user) return;
    api<UserProfile>('/user/me').then(setUser).catch(() => {});
  }, [user]);

  return (
    <div className="hall">
      <div className="hall-lt">{t('tab.hall')}</div>

      <div className="hall-lab">{t('hall.sec.activity')}</div>
      <div className="hall-act" onClick={() => nav('/activity/trip')}>
        <span className="hall-tag">{t('hall.trip.tag')}</span>
        <h3>{t('hall.trip.title')}</h3>
        <p>{t('hall.trip.desc', { app: t('app.name') })}</p>
        <span className="hall-act-go">{t('hall.trip.go')}<Ic n="right" s={13} /></span>
        <Plane size={120} />
      </div>

      <div className="hall-lab">{t('hall.sec.stroll')}</div>
      <div className="hall-wuyu" onClick={() => openWuyu(user?.gender)}>
        <div className="hall-wuyu-txt"><b>{t('hall.wuyu.name')}</b><span>{t('hall.wuyu.desc')}</span></div>
        <span className="hall-wuyu-go">{t('hall.enter')}</span>
      </div>
    </div>
  );
}

/**
 * 活动页「新婚旅行礼」。现在是占位版：只说有这件事，规则还没有，按钮点不了。
 * 【送审前必须换成有完整规则的真实活动页】（谁能参加、怎么证明、送什么、起止时间、举办方）——占位内容不能送审。
 * 送审时的样子见 design/07-hall.html 第 2 组，要用户给的 6 项规则记在 AI进度文档.md §8.2.1。
 */
export function TripPage() {
  const nav = useNavigate();
  // 是从大厅点进来的就退回大厅；直接打开这个网址的（没有上一页）回网页的大厅页
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? nav(-1) : nav('/hall', { replace: true }));
  return (
    <div className="hn-page" style={{ background: 'var(--hn-cream)' }}>
      <Nav title={t('trip.page')} onBack={back} />
      <div className="hn-scroll">
        <div className="trip-hero">
          <h3>{t('hall.trip.title')}</h3>
          <p>{t('hall.trip.desc', { app: t('app.name') })}</p>
          <Plane size={130} />
        </div>
        <div className="trip-box">
          <h4><Ic n="info" s={17} />{t('trip.rules')}</h4>
          <p>{t('trip.rulesPending')}</p>
        </div>
        <div className="trip-box">
          <h4><Ic n="heart" s={17} />{t('trip.now')}</h4>
          <p>{t('trip.nowText')}</p>
        </div>
      </div>
      <div className="trip-foot"><button className="hn-btn off" disabled>{t('trip.btn')}</button></div>
    </div>
  );
}
