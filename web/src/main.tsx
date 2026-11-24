import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './theme.css';
import { setToken } from './api';

// App 里用内嵌网页打开某一页（相亲画像、AI 费用）时，网址是 /#/card/me?token=xxx：
// 用 App 的登录身份，然后把 token 从网址里去掉（不留在浏览记录里）。大厅那个入口（/hall-embed）自己处理，不动它。
(() => {
  // 没登录时在 App 里打开「刷脸找回」：原生把自己的设备号放在 ?dev= 里带进来（找回成功后要挂到账号上的是原生那台设备）
  const dev = /[?&]dev=([\w.:-]{8,80})(?:&|$)/.exec(location.hash);
  if (dev) {
    try { sessionStorage.setItem('hn_native_dev', dev[1]); sessionStorage.setItem('hn_embed', '1'); } catch { /* 存不了就按浏览器处理 */ }
  }
  // App 里没登录时打开的内嵌网页（?token= 是空的）：内嵌网页里可能还留着上一次的登录身份，清掉，免得拿旧身份去请求
  if (/[?&]token=(?:&|$)/.test(location.hash) && !location.hash.startsWith('#/hall-embed')) setToken(null);
  const hit = /[?&]token=([^&#]+)/.exec(location.hash);
  if (!hit || location.hash.startsWith('#/hall-embed')) return;
  // 网址带进来的登录身份（App 内嵌网页等）：记一下，后面不拿网页自己的设备号去「进入」
  try { sessionStorage.setItem('hn_embed', '1'); } catch { /* 同上 */ }
  setToken(decodeURIComponent(hit[1]));
  const clean = location.hash.replace(/([?&])token=[^&#]+&?/, '$1').replace(/[?&]$/, '');
  history.replaceState(history.state, '', location.pathname + location.search + clean);
})();

// 全局：点空白处收起键盘（WebView 内偶尔点非交互区域不 blur）。点到输入框/按钮/链接等交互元素不处理。
document.addEventListener('click', (e) => {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) return;
  const t = e.target as Element | null;
  if (t && t.closest('input,textarea,select,[contenteditable],button,a,label,[role="button"]')) return;
  active.blur();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
