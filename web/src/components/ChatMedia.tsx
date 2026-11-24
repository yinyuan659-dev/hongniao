import { useEffect, useRef, useState } from 'react';
import { albumLayout } from '../album';
import { t } from '../i18n';

/** 正在上传 / 发送的本地图片的状态 */
export interface UploadState {
  /** 上传进度 0～1；传完等服务端确认时为 undefined */
  progress?: number;
  failed?: boolean;
}

/** 图片上盖的一层：上传中是进度圈，传完等确认时转圈，失败显示重试 */
export function UploadMask({ state, sending, onRetry }: { state?: UploadState; sending?: boolean; onRetry?: () => void }) {
  if (state?.failed) {
    return (
      <div className="up-mask no-menu" onClick={(e) => { e.stopPropagation(); onRetry?.(); }}>
        <span className="up-fail">!</span>
        <span className="up-tip">{t('chat.upload.retry')}</span>
      </div>
    );
  }
  const p = state?.progress;
  if (p === undefined && !sending) return null;
  const R = 17;
  const C = 2 * Math.PI * R;
  return (
    <div className="up-mask no-menu" onClick={(e) => e.stopPropagation()}>
      <svg width="44" height="44" viewBox="0 0 44 44" className={p === undefined ? 'up-spin' : undefined}>
        <circle cx="22" cy="22" r="20" fill="rgba(0,0,0,0.45)" />
        <circle
          cx="22" cy="22" r={R} fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round"
          strokeDasharray={`${p === undefined ? C * 0.28 : Math.max(0.04, p) * C} ${C}`}
          transform="rotate(-90 22 22)"
        />
      </svg>
    </div>
  );
}

export interface AlbumCell {
  key: string;
  src: string;
  w?: number;
  h?: number;
  state?: UploadState;
  sending?: boolean;
  /** 这一格的 DOM id（引用跳转 / 删除动画按消息 id 找元素） */
  domId?: string;
}

const GAP = 2;

/** Telegram 式多图拼版：圆角整块裁切，格子之间留 2px 缝 */
export function AlbumGrid({ cells, width, onTap, onRetry }: {
  cells: AlbumCell[];
  width: number;
  onTap: (i: number) => void;
  onRetry: (i: number) => void;
}) {
  const { rects, height } = albumLayout(cells.map((c) => (c.w && c.h ? c.w / c.h : 1)));
  const H = Math.round(height * width);
  return (
    <div className="album" style={{ width, height: H }}>
      {cells.map((c, i) => {
        const r = rects[i];
        const left = r.x * width + (r.x > 0.001 ? GAP / 2 : 0);
        const right = (r.x + r.w) * width - (r.x + r.w < 0.999 ? GAP / 2 : 0);
        const top = r.y * width + (r.y > 0.001 ? GAP / 2 : 0);
        const bottom = (r.y + r.h) * width - (r.y + r.h < height - 0.001 ? GAP / 2 : 0);
        return (
          <div
            key={c.key}
            id={c.domId}
            data-album-i={i}
            className="album-cell"
            style={{ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }}
          >
            <img src={c.src} alt="" onClick={() => onTap(i)} />
            <UploadMask state={c.state} sending={c.sending} onRetry={() => onRetry(i)} />
          </div>
        );
      })}
    </div>
  );
}

/** 文件消息内容 { url, name, size, mime }；本地刚选、还没传完的没有 url */
export interface FilePayload {
  url?: string;
  name: string;
  size: number;
  mime?: string;
}

export function parseFile(content: string): FilePayload {
  try {
    const o = JSON.parse(content);
    return { url: typeof o.url === 'string' && o.url ? o.url : undefined, name: String(o.name ?? ''), size: Number(o.size) || 0, mime: o.mime };
  } catch {
    return { name: '', size: 0 };
  }
}

/** 和后端 upload.service ALLOWED 一致：这些按图片 / 视频 / 语音发，其余（含超过 10MB 的音频）按文件发 */
const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/3gpp'];
const AUDIO_MAX = 10 * 1024 * 1024;

export type PickKind = 'image' | 'video' | 'audio' | 'file';

export function pickKind(f: { type: string; size: number }): PickKind {
  if (IMAGE_MIMES.includes(f.type)) return 'image';
  if (VIDEO_MIMES.includes(f.type)) return 'video';
  if (AUDIO_MIMES.includes(f.type) && f.size <= AUDIO_MAX) return 'audio';
  return 'file';
}

/** 音频时长（秒，取整，至少 1）；读不出来返回 0 */
export function audioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (d: number) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) && d > 0 ? Math.max(1, Math.round(d)) : 0);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/** 按十进制算，和「100MB」上限的说法一致 */
export function fmtSize(n: number) {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** 会话列表 / 引用条里的一行描述 */
export function fileSnippet(content: string) {
  const name = content ? parseFile(content).name : '';
  return name ? `${t('msg.preview.file')} ${name}` : t('msg.preview.file');
}

/** 直接走链接下载（服务端回 attachment），不读进内存，100MB 的文件也没事 */
export function downloadFile(f: FilePayload) {
  if (!f.url) return;
  const a = document.createElement('a');
  a.href = f.url;
  a.download = f.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const EXT_COLORS: [RegExp, string][] = [
  [/^pdf$/, '#e5484d'],
  [/^(docx?|pages|rtf|txt|md)$/, '#2f6fed'],
  [/^(xlsx?|csv|numbers)$/, '#1f9d55'],
  [/^(pptx?|key)$/, '#e8730c'],
  [/^(zip|rar|7z|gz|tar|bz2|xz)$/, '#8e6bd8'],
  [/^(apk|ipa|exe|dmg|msi)$/, '#13a8a8'],
  [/^(mp3|m4a|wav|flac|aac|ogg|mp4|mov|mkv|avi|webm)$/, '#d6409f'],
];

/** 文件气泡：上传中显示进度条，失败点了重试，传完点了下载 */
export function FileBubble({ f, state, onRetry }: { f: FilePayload; state?: UploadState; onRetry?: () => void }) {
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(f.name)?.[1] ?? '').toLowerCase();
  const color = EXT_COLORS.find(([re]) => re.test(ext))?.[1] ?? '#6b7a99';
  const p = state?.failed ? undefined : state?.progress;
  const inner = (
    <>
      <span className="file-icon" style={{ background: color }}>
        {ext ? (
          <em>{ext.toUpperCase()}</em>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" />
          </svg>
        )}
      </span>
      <span className="file-info">
        <span className="file-name">{f.name || t('msg.preview.file')}</span>
        <span className="file-meta">
          {state?.failed
            ? <span style={{ color: 'var(--danger)' }}>{t('chat.upload.retry')}</span>
            : p !== undefined ? `${fmtSize(Math.round(f.size * p))} / ${fmtSize(f.size)}` : fmtSize(f.size)}
        </span>
        {p !== undefined && <span className="file-bar"><i style={{ width: `${Math.round(p * 100)}%` }} /></span>}
      </span>
    </>
  );
  if (state?.failed) {
    return <span className="file-msg no-menu" onClick={(e) => { e.stopPropagation(); onRetry?.(); }}>{inner}</span>;
  }
  if (f.url && !state) return <a className="file-msg" href={f.url} download={f.name} rel="noopener" title={t('chat.file.download')}>{inner}</a>;
  return <span className="file-msg">{inner}</span>;
}

export const KeyboardGlyph = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6 10h.01M9.3 10h.01M12.6 10h.01M15.9 10h.01M6 13.5h.01M18 10h.01M18 13.5h.01M8.5 14h7" strokeWidth="2" />
  </svg>
);

/** 按住说话（网页版）：MediaRecorder 录 webm / mp4，服务端统一转成 m4a */
export function VoiceHoldButton({ onSend, onError }: { onSend: (blob: Blob, duration: number) => void; onError: (msg: string) => void }) {
  const [rec, setRec] = useState(false);
  const [cancel, setCancel] = useState(false);
  const mr = useRef<MediaRecorder | null>(null);
  const started = useRef(0);
  const chunks = useRef<Blob[]>([]);
  const want = useRef(false);
  const cancelRef = useRef(false);
  const startY = useRef(0);

  useEffect(() => () => {
    want.current = false;
    mr.current?.stream.getTracks().forEach((tr) => tr.stop());
  }, []);

  const start = async (y: number) => {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return onError(t('chat.voice.unsupported'));
    want.current = true;
    cancelRef.current = false;
    setCancel(false);
    startY.current = y;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      want.current = false;
      return onError(t('chat.voice.denied'));
    }
    // 申请权限的弹框期间已经松手了
    if (!want.current) return stream.getTracks().forEach((tr) => tr.stop());
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((x) => MediaRecorder.isTypeSupported?.(x));
    const r = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const dur = Math.round((Date.now() - started.current) / 1000);
      if (cancelRef.current) return;
      if (dur < 1) return onError(t('chat.voice.tooShort'));
      const mime = (r.mimeType || type || 'audio/webm').split(';')[0];
      onSend(new Blob(chunks.current, { type: mime }), Math.min(dur, 60));
    };
    mr.current = r;
    started.current = Date.now();
    r.start();
    setRec(true);
  };
  const stop = () => {
    want.current = false;
    setRec(false);
    const r = mr.current;
    mr.current = null;
    if (r && r.state !== 'inactive') r.stop();
  };
  const move = (y: number) => {
    if (!rec) return;
    const c = startY.current - y > 60;
    cancelRef.current = c;
    setCancel(c);
  };

  // 录满 60 秒自动发
  useEffect(() => {
    if (!rec) return;
    const timer = setTimeout(stop, 60_000);
    return () => clearTimeout(timer);
  }, [rec]);

  return (
    <>
      <div
        className={`voice-hold${rec ? ' on' : ''}`}
        onMouseDown={(e) => start(e.clientY)}
        onMouseUp={stop}
        onMouseLeave={() => rec && stop()}
        onMouseMove={(e) => move(e.clientY)}
        onTouchStart={(e) => { e.preventDefault(); start(e.touches[0].clientY); }}
        onTouchMove={(e) => move(e.touches[0].clientY)}
        onTouchEnd={(e) => { e.preventDefault(); stop(); }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {rec ? (cancel ? t('chat.voice.releaseCancel') : t('chat.releaseToSend')) : t('chat.holdToTalk')}
      </div>
      {rec && (
        <div className={`voice-overlay${cancel ? ' cancel' : ''}`}>
          <span className="voice-bars playing"><span /><span /><span /></span>
          <span>{cancel ? t('chat.voice.releaseCancel') : t('chat.voice.slideCancel')}</span>
        </div>
      )}
    </>
  );
}
