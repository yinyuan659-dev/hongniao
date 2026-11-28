import { useEffect, useState } from 'react';
import { HashRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { api, getToken, isEmbedSession, setToken, UserProfile } from './api';
import { useApp } from './store';
import { wsManager } from './ws';
import { LinkHost } from './components/LinkText';
import { EnterPage } from './pages/Enter';
import { RegisterPage } from './pages/Register';
import { PlazaPage } from './pages/Plaza';
import { HallPage, TripPage } from './pages/Hall';
import { LeaderboardPage, LeaderPage, TripDetailPage } from './pages/Trip';
import { LeaderHomePage, LeaderOrdersPage, LeaderPublishPage, LeaderTripPage } from './pages/Leader';
import { ChatListPage } from './pages/ChatList';
import { ChatRoomPage } from './pages/ChatRoom';
import { GroupInfoPage } from './pages/GroupInfo';
import { InterviewPage } from './pages/Interview';
import { MePage } from './pages/Me';
import { PublishPage } from './pages/Publish';
import { MyMomentsPage } from './pages/MyMoments';
import { MomentDetailPage } from './pages/MomentDetail';
import { PeoplePage } from './pages/People';
import { RealnamePage } from './pages/Realname';
import { KycPage } from './pages/Kyc';
import { KycMockPage } from './pages/KycMock';
import { KycResultPage } from './pages/KycResult';
import { RecoverPage } from './pages/Recover';
import { DeviceHost, DevicesPage } from './pages/Devices';
import { enterSession } from './session';
import { inNativeApp } from './bridge';
import { EditProfilePage } from './pages/EditProfile';
import { InviteCardPage } from './pages/InviteCard';
import { AgreementPage } from './pages/Agreement';
import { UserHomePage } from './pages/UserHome';
import { CardPage } from './pages/Card';
import { DeepChatPage } from './pages/DeepChat';
import { AiFeePage, AiKeyPage, AiLedgerPage, AiTopupPage } from './pages/AiFee';
import { LikesPage } from './pages/Likes';
import { MatchHost } from './match';
import { t } from './i18n';

function Shell() {
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState('');

  useEffect(() => {
    wsManager.connect();
    // 「消息」上的数字 = 没读的消息 + 新喜欢我的人
    const load = () =>
      Promise.all([
        api<any[]>('/im/conversations').then((list) => list.reduce((s, c) => s + (c.muted ? 0 : c.unread ?? 0), 0)),
        api<{ likedMeNew: number }>('/match/summary').then((s) => s.likedMeNew).catch(() => 0),
      ]).then(([msgs, likes]) => setUnread(msgs + likes)).catch(() => {});
    load();
    return wsManager.on((frame) => {
      // conv_refresh：会话列表有变化（群里进出、免打扰、解散…）；ws_reopen：断线后重新连上，补拉一次
      if (frame.op === 'msg' || frame.op === 'match' || frame.op === 'conv_refresh' || frame.op === 'ws_reopen') load();
      // 动态被评论 / 评论被回复：顶部弹一条提示
      if (frame.op === 'notify') {
        const d = frame.data ?? {};
        const text = frame.event === 'comment_reply'
          ? t('moments.notifyReply', { from: d.from, preview: d.preview })
          : t('moments.notifyComment', { from: d.from, preview: d.preview });
        setToast(text);
        setTimeout(() => setToast(''), 3000);
      }
    });
  }, []);

  return (
    <div className="app">
      {toast && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 200,
          background: 'rgba(20,20,24,0.95)', border: '1px solid var(--line)', padding: '10px 18px',
          borderRadius: 12, fontSize: 13, maxWidth: '86%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{toast}</div>
      )}
      <div className="page">
        <Outlet />
      </div>
      <nav className="tabbar">
        <NavLink to="/plaza" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>{t('tab.plaza')}</NavLink>
        <NavLink to="/hall" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>{t('tab.hall')}</NavLink>
        <div className="tab-plus" onClick={() => nav('/publish')}>
          <div className="plus-box">+</div>
        </div>
        <NavLink to="/chat" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>
          {t('tab.messages')}
          {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to="/me" className={({ isActive }) => `tab${isActive ? ' active' : ''}`}>{t('tab.me')}</NavLink>
      </nav>
    </div>
  );
}

/**
 * App 内嵌大厅（原生大厅 tab 的 WebView 入口）：
 * URL 带 ?token= 免登录（用 App 的身份），无底部导航（App 已有原生 tab 栏）。
 * 大厅里的内容写在 pages/Hall.tsx 里：送审时大厅里有什么，上线后就是什么；要加内容跟着新版本一起送审。
 */
function EmbedHallPage() {
  const [params] = useSearchParams();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = params.get('token');
    if (t) setToken(t);
    // App 内嵌 WebView：#root 直接钉成窗口像素高度，不依赖 html→body→#root 的 height:100% 链。
    // 华为/荣耀内核里这条链解析成了十几像素（.page 只剩 padding 高度、内容全被裁掉 → 大厅黑屏），innerHeight 却是对的。
    // #root 有了确定高度，之后在同一 WebView 里打开的子页面（.app{height:100%}）也一并正常
    const pin = () => {
      const root = document.getElementById('root');
      if (root && window.innerHeight > 0) root.style.height = `${window.innerHeight}px`;
    };
    pin();
    window.addEventListener('resize', pin);
    setReady(true);
    return () => window.removeEventListener('resize', pin);
  }, []);

  if (!ready) return null;
  return (
    <div className="app">
      <div className="page" style={{ paddingBottom: 12 }}>
        <HallPage />
      </div>
    </div>
  );
}

function Boot() {
  const nav = useNavigate();
  const setUser = useApp((s) => s.setUser);

  useEffect(() => {
    (async () => {
      try {
        // 这台设备挂在哪个账号下就登录哪个；不认识（新设备、被移除了）就去注册页，那里可以「刷脸找回」
        const r = await enterSession();
        if (r.registered && r.token) {
          nav('/plaza', { replace: true });
        } else {
          setToken(null);
          setUser(null);
          nav('/register', { replace: true });
        }
      } catch {
        nav('/register', { replace: true });
      }
    })();
  }, []);

  return (
    <div className="app">
      <div className="empty">{t('app.entering')}</div>
    </div>
  );
}

export function App() {
  // 子页面直接刷新 / 打开分享链接时不经过 Boot
  useEffect(() => {
    if (!getToken()) return;
    // 首页由 Boot 负责进入
    if (location.hash === '' || location.hash === '#' || location.hash === '#/') return;
    // App 内嵌网页、网址带进来的登录身份：不是网页自己这台设备的号，只补拉一次当前用户
    if (isEmbedSession() || inNativeApp()) {
      if (!useApp.getState().user) api<UserProfile>('/user/me').then((u) => !useApp.getState().user && useApp.getState().setUser(u)).catch(() => {});
      return;
    }
    // 浏览器里：用本机设备号重新进入一次，拿到带设备信息的新令牌，顺便看看不在的时候有没有新设备登录。
    // 服务器不认这台设备了（被别的设备移除了）→ 退出，去注册页
    enterSession().then((r) => {
      if (!r.registered) {
        setToken(null);
        useApp.getState().setUser(null);
        location.hash = '#/register';
      }
    }).catch(() => {});
  }, []);

  return (
    <HashRouter>
      <LinkHost />
      {/* 互相喜欢的庆祝页：哪个页面上都能弹出来 */}
      <MatchHost />
      {/* 账号在新设备登录了 / 本机被移除了 */}
      <DeviceHost />
      <Routes>
        <Route path="/" element={<Boot />} />
        <Route path="/enter" element={<EnterPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/agreement/:type" element={<AgreementPage />} />
        <Route path="/hall-embed" element={<EmbedHallPage />} />
        <Route element={<Shell />}>
          <Route path="/plaza" element={<PlazaPage />} />
          <Route path="/hall" element={<HallPage />} />
          <Route path="/chat" element={<ChatListPage />} />
          <Route path="/me" element={<MePage />} />
        </Route>
        {/* 大厅里的活动页「新婚旅行礼」（现在是占位版） */}
        <Route path="/activity/trip" element={<TripPage />} />
        {/* 领队旅行（样稿 design/13-travel.html）：排行榜、领队页、线路详情；领队后台、管一条线路、约单的人、发布 / 修改线路 */}
        <Route path="/trip/leaders" element={<LeaderboardPage />} />
        <Route path="/trip/leader/:id" element={<LeaderPage />} />
        <Route path="/trip/:id" element={<TripDetailPage />} />
        <Route path="/leader" element={<LeaderHomePage />} />
        <Route path="/leader/publish" element={<LeaderPublishPage />} />
        <Route path="/leader/trip/:id" element={<LeaderTripPage />} />
        <Route path="/leader/trip/:id/orders" element={<LeaderOrdersPage />} />
        <Route path="/publish" element={<PublishPage />} />
        <Route path="/my-moments" element={<MyMomentsPage />} />
        <Route path="/moment/:id" element={<MomentDetailPage />} />
        <Route path="/chatroom/:id" element={<ChatRoomPage />} />
        {/* 群资料（样稿 design/12-group.html 第 2 组）：从群聊页右上角「···」进 */}
        <Route path="/group/:id" element={<GroupInfoPage />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/people/:mode" element={<PeoplePage />} />
        <Route path="/realname" element={<RealnamePage />} />
        {/* 实人认证（身份证 + 刷脸）：并进基础画像的最后一步。kyc-mock 是测试期的模拟刷脸页；kyc-result 是真实刷脸（阿里云）刷完跳回来的结果页 */}
        <Route path="/kyc" element={<KycPage />} />
        <Route path="/kyc-mock" element={<KycMockPage />} />
        <Route path="/kyc-result" element={<KycResultPage />} />
        {/* 换手机找回（不用登录）、登录设备 */}
        <Route path="/recover" element={<RecoverPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/edit-profile" element={<EditProfilePage />} />
        <Route path="/invite-card" element={<InviteCardPage />} />
        {/* 别人的主页 = 相亲画像网页；原来的主页（动态、评分）挪到 /u/:id/home，从画像网页里「看 TA 的动态」进 */}
        <Route path="/u/:id" element={<CardPage />} />
        <Route path="/u/:id/home" element={<UserHomePage />} />
        <Route path="/card/:id" element={<CardPage />} />
        <Route path="/deep" element={<DeepChatPage />} />
        {/* 喜欢列表：喜欢我的 / 我喜欢的 / 互相喜欢（?tab=likedMe | liked | mutual） */}
        <Route path="/likes" element={<LikesPage />} />
        <Route path="/ai-fee" element={<AiFeePage />} />
        <Route path="/ai-fee/ledger" element={<AiLedgerPage />} />
        <Route path="/ai-fee/topup" element={<AiTopupPage />} />
        <Route path="/ai-fee/key" element={<AiKeyPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
