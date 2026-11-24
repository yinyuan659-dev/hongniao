/**
 * App 原生桥：大厅 H5 运行在原生 WebView（iOS WKWebView / Android WebView）里时，
 * 聊天等界面唤起原生页面；普通浏览器访问时桥不存在，自动回退网页内跳转。
 */

/** 尝试唤起原生聊天页，成功返回 true（调用方不再走网页路由） */
export function openNativeChat(convId: string, convType: number, targetId: string, title: string): boolean {
  const payload = { type: 'openChat', convId, convType, targetId, title };
  // iOS WKWebView
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    try {
      wk.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }
  // Android WebView（addJavascriptInterface）
  const droid = (window as any).PeiwanNative;
  if (droid?.openChat) {
    try {
      droid.openChat(convId, String(convType), targetId, title);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * AI 红娘的网页（相亲画像、AI 费用）在 App 里是用内嵌网页打开的，有些动作要交给原生：
 *   close        关掉这一页，回到原生页面
 *   interview    回原生的问答页改某一题（args.edit = 题目 key）
 *   editProfile  打开原生的「基本资料」页（换头像、昵称、照片）
 *   deep         打开原生的 AI 深聊页
 *   userHome     打开原生的对方主页（看动态；args.id = 用户 id）
 *   matched      刚互相喜欢：让原生弹出庆祝页（args.id / nickname / avatar = 对方，conversationId = 你们的会话）
 *   session      登录身份换了（刷脸找回成功、并号进了原来的账号）：原生改用 args.token（args.did = 设备编号），关掉网页、重新进入
 *   kycDone      真人认证通过了：原生刷新自己的状态
 * 成功交给原生返回 true；在普通浏览器里（或老版本 App 没有这个桥）返回 false，调用方走网页自己的跳转。
 */
export function hnNative(action: 'close' | 'interview' | 'editProfile' | 'deep' | 'userHome' | 'matched' | 'session' | 'kycDone', args: Record<string, string> = {}): boolean {
  const w = window as any;
  try {
    // iOS WKWebView：只有 AI 红娘的内嵌网页容器会注入 __hnBridge，大厅那个容器不认识这些动作
    if (w.__hnBridge && w.webkit?.messageHandlers?.peiwan) {
      w.webkit.messageHandlers.peiwan.postMessage({ type: 'hn', action, ...args });
      return true;
    }
    // Android WebView
    if (w.PeiwanNative?.hn) {
      w.PeiwanNative.hn(JSON.stringify({ action, ...args }));
      return true;
    }
  } catch {
    /* 交给调用方走网页跳转 */
  }
  return false;
}

/** 是否运行在 App 原生 WebView 里（任一桥存在） */
export function inNativeApp(): boolean {
  const w = window as any;
  return !!(w.webkit?.messageHandlers?.peiwan || w.PeiwanNative);
}

export type WebOrientation = 'portrait' | 'landscape';

/**
 * 唤起原生全屏网页容器打开 url（小游戏等第三方 H5）：独立于大厅 WebView，
 * 带标题栏/关闭，游戏内导航不影响大厅页；orientation 指定该页屏幕方向（横屏游戏旋转屏幕）。成功返回 true。
 */
export function openNativeWeb(url: string, title: string, orientation: WebOrientation = 'portrait'): boolean {
  const payload = { type: 'openWeb', url, title, orientation };
  const wk = (window as any).webkit?.messageHandlers?.peiwan;
  if (wk) {
    try {
      wk.postMessage(payload);
      return true;
    } catch {
      return false;
    }
  }
  const droid = (window as any).PeiwanNative;
  if (droid?.openWeb) {
    try {
      droid.openWeb(url, title, orientation);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
