import { lang, t } from './i18n';

// http 环境（非安全上下文）没有 crypto.randomUUID，做降级
function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 设备 ID（Web 端用 localStorage UUID，一机一号 + 卸载恢复的 Web 等价实现）
export function getDeviceId(): string {
  let id = localStorage.getItem('pw_device_id');
  if (!id) {
    id = 'web_' + randomId();
    localStorage.setItem('pw_device_id', id);
  }
  return id;
}

export function getToken(): string | null {
  return localStorage.getItem('pw_token');
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem('pw_token', token);
  else {
    localStorage.removeItem('pw_token');
    localStorage.removeItem('pw_did');
  }
}

/** 这台设备在服务器「登录设备」表里的编号（进入 / 找回 / 并号时服务器给的）。用来认出推送里说的是不是本机 */
export function getDid(): string {
  return localStorage.getItem('pw_did') ?? '';
}

export function setDid(did: string | null | undefined) {
  if (did) localStorage.setItem('pw_did', did);
  else localStorage.removeItem('pw_did');
}

/**
 * 这一次是不是「借来的登录身份」：App 内嵌网页（原生把 token 放在网址里带进来），或者别的带 ?token= 的链接。
 * 这种情况下不能拿网页自己的设备号去「进入」（那不是这个身份的设备）。只在当前标签页有效。
 */
export function isEmbedSession(): boolean {
  try { return sessionStorage.getItem('hn_embed') === '1'; } catch { return false; }
}

/** App 内嵌网页里，原生通过网址 ?dev= 带进来的原生设备号（刷脸找回要挂的是原生那台设备，不是内嵌网页自己的） */
export function nativeDeviceId(): string {
  try { return sessionStorage.getItem('hn_native_dev') ?? ''; } catch { return ''; }
}

/** 找回时要挂到账号上的设备号：在 App 里是原生的，在浏览器里是网页自己的 */
export function loginDeviceId(): string {
  return nativeDeviceId() || getDeviceId();
}

export async function api<T = any>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept-Language': lang() };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await res.json();
  if (json.code !== 0) {
    if (json.code === 401) {
      setToken(null);
      location.hash = '#/enter';
    }
    // reason：服务端给的原因代码（例如 AI 费用的 no_balance / key_invalid），页面按它决定弹哪张提示
    throw Object.assign(new Error(json.msg || t('common.requestFailed')), { reason: json.reason as string | undefined, code: json.code as number });
  }
  return json.data as T;
}

/** 从接口报错里取原因代码（没有就是空字符串） */
export const reasonOf = (e: unknown): string => (e as { reason?: string })?.reason ?? '';

/** 登录后上传（image | video） */
export async function uploadFile(kind: 'image' | 'video', file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/upload/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}`, 'Accept-Language': lang() },
    body: form,
  });
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.msg || t('common.uploadFailed'));
  return json.data.url as string;
}

/** POST multipart 到 /api/upload/...，返回 data；onProgress 0～1 */
function postUpload<T>(path: string, blob: Blob, filename: string, onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', blob, filename);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    xhr.setRequestHeader('Accept-Language', lang());
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      // Cloudflare / nginx 拦下超大包体时回的是 HTML 413
      if (xhr.status === 413) return reject(new Error(t('chat.file.tooLarge', { name: filename })));
      try {
        const json = JSON.parse(xhr.responseText);
        if (json.code !== 0) return reject(new Error(json.msg || t('common.uploadFailed')));
        resolve(json.data as T);
      } catch {
        reject(new Error(t('common.uploadFailed')));
      }
    };
    xhr.onerror = () => reject(new Error(t('common.uploadFailed')));
    xhr.send(form);
  });
}

/** 带进度的上传（onProgress 0～1） */
export async function uploadBlob(kind: 'image' | 'video' | 'audio', blob: Blob, filename: string, onProgress?: (p: number) => void): Promise<string> {
  return (await postUpload<{ url: string }>(kind, blob, filename, onProgress)).url;
}

/** 聊天文件上限，和后端 FILE_MAX_SIZE 一致：再大 Cloudflare 免费版直接回 413 */
export const FILE_MAX_SIZE = 100_000_000;

export interface ChatFile {
  url: string;
  name: string;
  size: number;
  mime: string;
}

/** 聊天里发任意文件：返回的对象原样作为 file 消息的 content */
export function uploadChatFile(file: File, onProgress?: (p: number) => void): Promise<ChatFile> {
  return postUpload<ChatFile>('file', file, file.name, onProgress);
}

export interface UserProfile {
  id: string;
  shortId?: string;
  nickname: string;
  avatar: string;
  gender: number;
  age: number;
  cityCode: string;
  cityName: string;
  signature: string;
  isGuide: boolean;
  /** 视频见面开关（默认关；双方都打开才能互相发起视频通话） */
  allowVideo?: boolean;
  /** 是否已完成资料收集（只有 /user/me 返回） */
  profileDone?: boolean;
  /** AI 深聊：none 没聊过 | chatting 聊到一半 | draft 画像等确认 | done 已确认（只有 /user/me 返回） */
  deepStatus?: 'none' | 'chatting' | 'draft' | 'done';
  realname?: boolean;
  realNameMasked?: string;
  /** 注册时间 */
  createdAt?: string;
  following?: number;
  fans?: number;
  /** 照片墙（最多 8 张） */
  albums?: { id: string; type: number; url: string; coverUrl?: string; sort?: number }[];
}
