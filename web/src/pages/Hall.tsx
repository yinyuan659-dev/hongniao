import { useNavigate } from 'react-router-dom';
import { Ic, Nav } from '../hn';
import { t } from '../i18n';

/**
 * 大厅：内容直接写在这里，不走后台配置（样稿 design/07-hall.html，用户 2026-11-25 过关）。
 *   活动「前 10 对结婚的新人送旅行」→ 活动页（现在是占位版，规则还没定）
 * 大厅里有什么以发出去的这一版为准：要加别的活动就改这个文件、发新版本，不靠后台开关变出来。
 *
 * 「相亲物语」那张卡 2026-11-27 用户说先不要了：入口拿掉、wuyu.html 不再构建和部署，程序留在 src/wuyu/ 和 web/wuyu.html。
 * 要加回来：这个文件的入口（wuyuUrl / openWuyu / 第二张卡）、theme.css 的 .hall-wuyu、两个语言文件的 hall.wuyu.* 都在提交 1a8972a 里；
 * vite.config.ts 的 input 里加回 wuyu；封面图从 src/wuyu/cover.jpg 放回 public/wuyu-cover.jpg。
 */

/** 活动卡右下角的小飞机（装饰） */
function Plane({ size }: { size: number }) {
  return (
    <svg className="hall-plane" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  );
}

export function HallPage() {
  const nav = useNavigate();

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
