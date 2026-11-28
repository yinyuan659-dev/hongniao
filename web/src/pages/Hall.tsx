import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PullToRefresh } from '../components/PullToRefresh';
import { Ic, Nav } from '../hn';
import { t } from '../i18n';
import { TravelTab } from './Trip';
import '../trip.css';

/**
 * 大厅：顶上两个 tab「旅行 / 相亲活动」，下面直接是列表（样稿 design/13-travel.html 第 1 组，用户 2026-11-28 过关；
 * tab 的做法是 2026-11-27 定的，见 design/11-hall-travel.html）。内容直接写在这里，不走后台配置：
 * 大厅里有什么以发出去的这一版为准，要加别的就改这个文件、发新版本，不靠后台开关变出来。
 *   旅行      第 2 步「领队旅行」：我的领队 + 领队排行榜入口 + 他的线路（pages/Trip.tsx 的 TravelTab）
 *   相亲活动  第 3 步，还没做，现在只有一句「即将开放」。【送审的版本里不能有空 tab：第 3 步做完再送审】
 * 这一页在 App 里是内嵌网页（/hall-embed），浏览器里是底部「大厅」。
 *
 * 原来大厅上的活动卡「前 10 对结婚的新人送旅行」2026-11-27 起先拿掉了（要不要留用户还没定），活动页 TripPage 和路由还在，只是没有入口。
 * 「相亲物语」那张卡 2026-11-27 用户说先不要了：入口拿掉、wuyu.html 不再构建和部署，程序留在 src/wuyu/ 和 web/wuyu.html。
 * 要加回来：入口（wuyuUrl / openWuyu / 卡片）、theme.css 的 .hall-wuyu、两个语言文件的 hall.wuyu.* 都在提交 1a8972a 里；
 * vite.config.ts 的 input 里加回 wuyu；封面图从 src/wuyu/cover.jpg 放回 public/wuyu-cover.jpg。
 */

/** 活动页右下角的小飞机（装饰） */
function Plane({ size }: { size: number }) {
  return (
    <svg className="hall-plane" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
    </svg>
  );
}

const TAB_KEY = 'hn_hall_tab';

export function HallPage() {
  // 记住停在哪个 tab：看完线路回来还在原来的地方
  const [tab, setTabState] = useState<'trip' | 'event'>(() => {
    try { return sessionStorage.getItem(TAB_KEY) === 'event' ? 'event' : 'trip'; } catch { return 'trip'; }
  });
  const setTab = (v: 'trip' | 'event') => {
    setTabState(v);
    try { sessionStorage.setItem(TAB_KEY, v); } catch { /* 存不了就算了 */ }
  };

  /** 现在这个 tab 怎么重新取一次（旅行 tab 把自己的取数函数放进来；相亲活动还没有内容，没有可取的） */
  const reloadRef = useRef<(() => Promise<unknown>) | null>(null);
  /**
   * 手动刷新（2026-11-28 用户要的）：往下拉，或者再点一下已经选中的 tab。
   * 平时列表靠服务器推送自己更新，但 App 里大厅这一页是一直开着的，推送万一漏了（断网、切到后台很久）得有个办法自己刷。
   * 至少转 0.4 秒，不然取得太快，「刷新中…」一闪就没了，像没反应。
   */
  const refresh = () => Promise.all([
    tab === 'trip' ? reloadRef.current?.() : undefined,
    new Promise((r) => setTimeout(r, 400)),
  ]);
  const pick = (v: 'trip' | 'event') => (v === tab ? void refresh() : setTab(v));

  return (
    <div className="tp-hall">
      <PullToRefresh onRefresh={refresh}>
        <div className="tp-tt">
          <span className={tab === 'trip' ? 'on' : ''} data-tab="trip" onClick={() => pick('trip')}>旅行</span>
          <span className={tab === 'event' ? 'on' : ''} data-tab="event" onClick={() => pick('event')}>相亲活动</span>
        </div>
        {tab === 'trip' ? <TravelTab reloadRef={reloadRef} /> : (
          <div className="tp-empty">相亲活动即将开放。{'\n'}到时候可以在这里发起同城的户外活动，或者参加别人发起的。</div>
        )}
      </PullToRefresh>
    </div>
  );
}

/**
 * 活动页「新婚旅行礼」。现在是占位版：只说有这件事，规则还没有，按钮点不了。大厅上现在没有入口进这一页。
 * 【要放回大厅、送审前必须换成有完整规则的真实活动页】（谁能参加、怎么证明、送什么、起止时间、举办方）——占位内容不能送审。
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
