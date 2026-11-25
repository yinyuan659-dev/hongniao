import { useEffect, useState } from 'react';
import { api, getToken, UserProfile } from '../api';
import { inNativeApp, isOwnWebUrl, openNativeWeb, WebOrientation } from '../bridge';
import { useApp } from '../store';
import { PullToRefresh } from '../components/PullToRefresh';
import { t } from '../i18n';

interface ProjectItem {
  id: number;
  name: string;
  icon: string;
  desc: string;
  cover: string;
  /** native=客户端内置页 h5=横幅内嵌网页 game=小游戏（九宫格） */
  type: string;
  entry: string;
  /** 小游戏屏幕方向：portrait / landscape（App 游戏页按此旋转） */
  orientation?: string;
}

/** 大厅页版本标记，日志里用来确认 App 加载到的是不是新部署的 H5 */
const HALL_VERSION = '2026-09-15-hall-tabs-v4';

const COVERS = [
  'linear-gradient(120deg, #3d0f1f 0%, #7a1f3d 55%, #b32b53 100%)',
  'linear-gradient(120deg, #101a2e 0%, #1c3a6e 60%, #2b5cb0 100%)',
  'linear-gradient(120deg, #241436 0%, #4a2580 60%, #7a3fd1 100%)',
];

/** 游戏链接占位符：{token} 登录态、{uid} 用户 ID（后台配置时选填；入口只能是我们自己的网页，令牌不会发给别的网站） */
function fillEntry(entry: string, uid: string): string {
  return entry
    .replace(/\{token\}/g, encodeURIComponent(getToken() ?? ''))
    .replace(/\{uid\}/g, encodeURIComponent(uid));
}

/**
 * 打开小游戏：App 内走原生全屏 WebView（独立于大厅页，带标题栏/关闭）；
 * 浏览器新标签打开；被拦截则当前页跳转。只开我们自己的网页。
 */
function openGameUrl(url: string, title: string, orientation: WebOrientation) {
  const w = window as any;
  if (!isOwnWebUrl(url)) {
    console.warn('[Game] refused: not our own site');
    return;
  }
  console.log(
    `[Game] open url=${url.split('token=')[0]} title=${title} orientation=${orientation} ` +
      `bridge: wk=${!!w.webkit?.messageHandlers?.peiwan} droid=${!!w.PeiwanNative} droid.openWeb=${typeof w.PeiwanNative?.openWeb}`,
  );
  if (openNativeWeb(url, title, orientation)) {
    console.log('[Game] native bridge accepted');
    return;
  }
  if (inNativeApp()) {
    console.log('[Game] in app but no openWeb bridge (old app), fallback location.href');
    location.href = url;
    return;
  }
  console.log('[Game] browser fallback window.open');
  const win = window.open(url, '_blank', 'noopener');
  if (!win) location.href = url;
}

/** 大厅：后台配置的 H5 横幅项目 + 休闲游戏（九宫格） */
export function HallPage() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const loadProjects = () =>
    api<ProjectItem[]>('/modules')
      .then((list) => {
        console.log(
          `[Game] /modules ok: ${list.length} items, games=${list.filter((p) => p.type === 'game').length} ` +
            list.map((p) => `${p.type}:${p.name}${p.type === 'game' ? `(${p.orientation ?? 'portrait'})` : ''}`).join(', '),
        );
        // 入口不是我们自己网页的不显示（App 里点了也打不开，原生会拦）
        const own = list.filter((p) => (p.type !== 'h5' && p.type !== 'game') || isOwnWebUrl(p.entry));
        if (own.length !== list.length) console.warn(`[Game] ${list.length - own.length} item(s) hidden: entry is not our own site`);
        setProjects(own);
      })
      .catch((e) => console.error('[Game] /modules failed', e?.message ?? e))
      .finally(() => setLoaded(true));

  useEffect(() => {
    console.log(`[Game] hall mounted, version=${HALL_VERSION} path=${location.pathname}${location.hash}`);
    loadProjects();
  }, []);

  // 内嵌模式只带 token 未拉用户资料；游戏链接可能要 {uid}，补一次
  useEffect(() => {
    if (user) return;
    api<UserProfile>('/user/me').then(setUser).catch(() => {});
  }, [user]);

  // 后台配置的横幅项目（H5）
  const banners = projects.filter((p) => p.type === 'h5');
  const games = projects.filter((p) => p.type === 'game');

  const openBanner = (p: ProjectItem) => {
    if (p.type === 'h5' && isOwnWebUrl(p.entry)) location.href = p.entry;
  };

  const openGame = (g: ProjectItem) => {
    console.log(`[Game] click game id=${g.id} name=${g.name}`);
    openGameUrl(fillEntry(g.entry, user?.id ?? ''), g.name, g.orientation === 'landscape' ? 'landscape' : 'portrait');
  };

  return (
    <div style={{ padding: '4px 16px' }}>
      <PullToRefresh onRefresh={loadProjects}>
        {banners.map((p, i) => (
          <div
            key={p.id}
            onClick={() => openBanner(p)}
            style={{
              position: 'relative', borderRadius: 16, overflow: 'hidden', cursor: 'pointer',
              marginTop: 14, height: 120,
              background: p.cover ? `url(${p.cover}) center/cover` : COVERS[i % COVERS.length],
            }}
          >
            <div style={{ position: 'absolute', left: 18, bottom: 16, right: 100 }}>
              <div style={{ fontSize: 19, fontWeight: 700, color: '#fff', letterSpacing: 1 }}>{p.name}</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', marginTop: 5 }}>{p.desc}</div>
            </div>
            <span style={{
              position: 'absolute', right: 16, bottom: 16,
              padding: '7px 20px', borderRadius: 16, fontSize: 13, fontWeight: 600,
              background: 'rgba(255,255,255,0.92)', color: '#111',
            }}>
              {t('hall.enter')}
            </span>
          </div>
        ))}
        {games.length > 0 && (
          <div className="game-grid">
            {games.map((g) => (
              <div key={g.id} className="game-cell" onClick={() => openGame(g)}>
                <img src={g.icon} alt={g.name} />
                <div className="name ellipsis">{g.name}</div>
                {g.desc && <div className="desc">{g.desc}</div>}
              </div>
            ))}
          </div>
        )}
        {loaded && banners.length === 0 && games.length === 0 && <div className="empty">{t('hall.gamesComing')}<br />{t('hall.stayTuned')}<br /><span className="small">{t('ptr.pull')}</span></div>}
      </PullToRefresh>
    </div>
  );
}
