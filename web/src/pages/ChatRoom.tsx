import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, FILE_MAX_SIZE, uploadBlob, uploadChatFile, uploadFile } from '../api';
import { groupAlbums, imageContent, imageUrl, newAlbumId, parseImage, readImageSize, shrinkImage, uploadInOrder } from '../album';
import { AlbumGrid, audioDuration, downloadFile, FileBubble, KeyboardGlyph, parseFile, PickKind, pickKind, UploadMask, UploadState, VoiceHoldButton } from '../components/ChatMedia';
import { useApp } from '../store';
import { wsManager, MessagePayload, Reaction, ReplyPreview } from '../ws';
import { nearestCity } from '../cities';
import { dropLastGrapheme } from '../emojis';
import { EmojiPanel } from '../components/EmojiPanel';
import { AttachSheet, AttachAction } from '../components/AttachSheet';
import { LinkText } from '../components/LinkText';
import {
  DeleteDialog, FORWARDABLE, ForwardSheet, MenuActions, MsgMenu, PinBar, PinItem,
  ReactionChips, ReplyBar, ReplyQuote, ReportSheet, saveMedia,
} from '../components/MsgActions';
import { decodeQrFromImage, ScanIcon } from '../components/QrScanner';
import { ScanFlow } from './ChatList';
import { t } from '../i18n';
import { Relation, ReportSheet as UserReportSheet } from '../match';

/** 「11 月 23 日」 */
function matchDay(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

interface MsgItem {
  id: string;
  senderId: string;
  senderNickname: string;
  senderAvatar?: string;
  type: string;
  content: string;
  createdAt: string;
  isRead?: boolean;
  pending?: boolean;
  tempId?: string;
  replyTo?: ReplyPreview | null;
  fwdFrom?: string | null;
  reactions?: Reaction[];
  /** 本地刚选的图：上传期间和发出后都用本地预览显示 */
  local?: string;
  /** 本地上传任务的 key（进度、失败重试按它找） */
  upKey?: string;
}

/** 图片显示地址：本地预览优先 */
const imgSrc = (m: MsgItem) => m.local || imageUrl(m.content);

/** 相册几张图的表情回应合在一起显示 */
function mergeReactions(list: MsgItem[]): Reaction[] {
  const map = new Map<string, Reaction>();
  for (const m of list) {
    for (const r of m.reactions ?? []) {
      const cur = map.get(r.emoji);
      if (cur) map.set(r.emoji, { emoji: r.emoji, count: cur.count + r.count, userIds: [...cur.userIds, ...r.userIds] });
      else map.set(r.emoji, { ...r, userIds: [...r.userIds] });
    }
  }
  return [...map.values()];
}

/** 单张图按宽高预留尺寸（加载前不跳动） */
function singleSize(w?: number, h?: number): { width: number; height: number } | undefined {
  if (!w || !h) return undefined;
  const s = Math.min(220 / w, 280 / h, 1);
  return { width: Math.max(60, Math.round(w * s)), height: Math.max(60, Math.round(h * s)) };
}

/** Web 端点语音/视频弹下载引导 */
function DownloadDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="mask" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{t('chat.download.title')}</h3>
        <p>{t('chat.download.desc1')}<br />{t('chat.download.desc2')}</p>
        <button className="btn" onClick={() => (location.href = '/site/')}>{t('chat.download.go')}</button>
        <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 语音气泡：播放中声条跳动 */
function AudioBubble({ a }: { a: any }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggle = () => {
    if (playing) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlaying(false);
      return;
    }
    const audio = new Audio(a.url);
    audioRef.current = audio;
    audio.onended = () => setPlaying(false);
    audio.onerror = () => setPlaying(false);
    audio.play().then(() => setPlaying(true)).catch(() => {});
  };

  return (
    <span className="row no-menu" style={{ gap: 8, cursor: 'pointer' }} onClick={toggle}>
      <span className={`voice-bars${playing ? ' playing' : ''}`}>
        <span /><span /><span />
      </span>
      <span>{t('msg.voice')} {a.duration ? `${a.duration}"` : ''}</span>
    </span>
  );
}

/** 点这些元素走它们自己的逻辑（看大图、播放、点链接等），不弹消息菜单 */
const NO_MENU = 'a,img,video,audio,.no-menu,.react-chips,.reply-quote';

function MsgBubble({ m, album, mine, myId, uploads, onImage, onMenu, onReact, onJump, onRetry }: {
  m: MsgItem;
  /** 多图相册（第一张就是 m） */
  album?: MsgItem[];
  mine: boolean; myId?: string;
  uploads?: Record<string, UploadState>;
  onImage: (url: string) => void;
  /** target：相册里长按的那一张 */
  onMenu: (x: number, y: number, target?: MsgItem) => void;
  onReact: (emoji: string, target?: MsgItem) => void;
  onJump: (id: string) => void;
  onRetry?: (m: MsgItem) => void;
}) {
  const press = useRef<ReturnType<typeof setTimeout>>();
  const pressed = useRef(false);
  const isMedia = m.type === 'image' || m.type === 'video';
  const all = album ?? [m];
  const targetOf = (el: EventTarget | null) => {
    const i = Number((el as Element | null)?.closest?.('[data-album-i]')?.getAttribute('data-album-i'));
    return album && Number.isInteger(i) ? album[i] : undefined;
  };
  let body: JSX.Element;
  switch (m.type) {
    case 'image': {
      if (album) {
        body = (
          <AlbumGrid
            width={240}
            cells={album.map((a, i) => {
              const meta = parseImage(a.content);
              return {
                key: a.upKey ?? a.tempId ?? a.id, src: imgSrc(a), w: meta.w, h: meta.h,
                state: a.upKey ? uploads?.[a.upKey] : undefined, sending: a.pending,
                domId: `cell-${a.id}`,
              };
            })}
            onTap={(i) => !album[i].upKey || !uploads?.[album[i].upKey!] ? onImage(imgSrc(album[i])) : undefined}
            onRetry={(i) => onRetry?.(album[i])}
          />
        );
      } else {
        const meta = parseImage(m.content);
        const size = singleSize(meta.w, meta.h);
        body = (
          <span className="img-wrap">
            <img src={imgSrc(m)} alt="" style={{ cursor: 'pointer', ...(size ? { ...size, objectFit: 'cover' } : {}) }} onClick={() => onImage(imgSrc(m))} />
            <UploadMask state={m.upKey ? uploads?.[m.upKey] : undefined} sending={m.pending} onRetry={() => onRetry?.(m)} />
          </span>
        );
      }
      break;
    }
    case 'video':
      body = m.content ? <video src={m.content} controls playsInline style={{ background: '#000' }} /> : (
        <span className="img-wrap">
          <span className="video-ph" />
          <UploadMask state={m.upKey ? uploads?.[m.upKey] : undefined} sending={m.pending} onRetry={() => onRetry?.(m)} />
        </span>
      );
      break;
    case 'audio': {
      let a: any = {};
      try { a = JSON.parse(m.content); } catch { a = { url: m.content }; }
      body = <AudioBubble a={a} />;
      break;
    }
    case 'file':
      body = <FileBubble f={parseFile(m.content)} state={m.upKey ? uploads?.[m.upKey] : undefined} onRetry={() => onRetry?.(m)} />;
      break;
    case 'location': {
      let loc: any = {};
      try { loc = JSON.parse(m.content); } catch {}
      body = (
        <span
          className="row no-menu"
          style={{ gap: 8, cursor: 'pointer' }}
          onClick={() => loc.lat && window.open(`https://uri.amap.com/marker?position=${loc.lng},${loc.lat}`, '_blank')}
        >
          <span style={{ fontSize: 16 }}>◎</span>
          <span>{loc.name || loc.address || t('msg.location')}</span>
        </span>
      );
      break;
    }
    default:
      if (m.type === 'call' || m.type.startsWith('call')) {
        let c: any = {};
        try { c = JSON.parse(m.content); } catch {}
        const label = c.callType === 2 ? t('msg.call.video') : t('msg.call.voice');
        const dur = c.duration ?? 0;
        const text = c.result === 'end'
          ? `${label} ${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(dur % 60).padStart(2, '0')}`
          : c.result === 'reject' ? t('msg.call.rejected', { label }) : t('msg.call.canceled', { label });
        body = <span className="row" style={{ gap: 8 }}><span style={{ fontSize: 15 }}>{c.callType === 2 ? '▣' : '✆'}</span><span>{text}</span></span>;
      } else {
        body = <LinkText text={m.content} style={{ whiteSpace: 'pre-wrap' }} />;
      }
  }
  const avatar = (
    <div className="avatar" style={{ width: 36, height: 36, flexShrink: 0 }}>
      {m.senderAvatar && <img src={m.senderAvatar} alt="" />}
    </div>
  );

  return (
    <div className={`bubble-row${mine ? ' mine' : ''}`} style={{ gap: 8, alignItems: 'flex-start' }}>
      {!mine && avatar}
      <div
        className="bubble-wrap"
        onClick={(e) => {
          if (pressed.current) { pressed.current = false; return; }
          if ((e.target as Element).closest(NO_MENU)) return;
          onMenu(e.clientX, e.clientY, targetOf(e.target));
        }}
        onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY, targetOf(e.target)); }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          const target = targetOf(e.target);
          pressed.current = false;
          press.current = setTimeout(() => { pressed.current = true; onMenu(touch.clientX, touch.clientY, target); }, 450);
        }}
        onTouchMove={() => clearTimeout(press.current)}
        onTouchEnd={() => clearTimeout(press.current)}
      >
        {/* 对齐 iOS：只显示对方昵称，自己的不显示 */}
        {!mine && <div className="small" style={{ marginBottom: 3 }}>{m.senderNickname}</div>}
        <div className={`bubble ${mine ? 'mine' : 'theirs'}${isMedia ? ' media' : ''}`} style={{ opacity: m.pending && m.type !== 'image' && m.type !== 'file' && m.type !== 'video' ? 0.6 : 1 }}>
          {m.fwdFrom && <div className="fwd-from">{t('msg.fwdFrom', { name: m.fwdFrom })}</div>}
          {m.replyTo && <ReplyQuote r={m.replyTo} onClick={() => onJump(m.replyTo!.id)} />}
          {body}
        </div>
        <ReactionChips
          reactions={album ? mergeReactions(album) : m.reactions}
          myId={myId}
          onToggle={(e) => onReact(e, album && myId ? album.find((a) => a.reactions?.some((r) => r.emoji === e && r.userIds.includes(myId))) : undefined)}
        />
        <div className="msg-meta" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
          {all.some((a) => a.pending) && (
            all.some((a) => a.upKey && uploads?.[a.upKey]?.failed)
              ? <span style={{ color: 'var(--danger)' }}>{t('chat.upload.failed')}</span>
              : <span>{all.some((a) => a.upKey && uploads?.[a.upKey]) ? t('chat.upload.uploading') : t('msg.sending')}</span>
          )}
          {mine && !all.some((a) => a.pending) && (
            <span className={all.every((a) => a.isRead) ? '' : 'accent'}>{all.every((a) => a.isRead) ? t('msg.read') : t('msg.unread')}</span>
          )}
        </div>
      </div>
      {mine && avatar}
    </div>
  );
}

export function ChatRoomPage() {
  const { id: conversationId } = useParams<{ id: string }>();
  const location = useLocation();
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const navState = (location.state ?? {}) as { title?: string; targetId?: string; focusMsgId?: string; draft?: string };
  // 正常是从上一页带着「对方是谁」进来的；直接打开这个网址（没带）时，从会话列表里找出对方
  const [found, setFound] = useState<{ title?: string; targetId?: string }>({});
  const state = { ...found, ...navState };
  useEffect(() => {
    if (navState.targetId || !conversationId) return;
    api<{ id: string; peer?: { id: string; nickname: string } }[]>('/im/conversations')
      .then((list) => {
        const c = list.find((x) => x.id === conversationId);
        if (c?.peer) setFound({ title: c.peer.nickname, targetId: c.peer.id });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const [messages, setMessages] = useState<MsgItem[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // draft：从互相喜欢的庆祝页点了一句开场白进来，先填进输入框，可以改了再发
  const [input, setInput] = useState(state.draft ?? '');
  /** 我和对方的关系：顶上的提示用；只有一方点了「不再联系」时不能发消息 */
  const [rel, setRel] = useState<Relation | null>(null);
  const [reporting, setReporting] = useState(false);
  const targetRef = useRef(state.targetId);
  targetRef.current = state.targetId;
  const loadRel = () => {
    if (targetRef.current) api<Relation>(`/match/relation/${targetRef.current}`).then(setRel).catch(() => {});
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadRel, [state.targetId]);
  const [showDownload, setShowDownload] = useState(false);
  const [navMenu, setNavMenu] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  /** 本地图片上传任务：进度 / 失败；原文件留着给失败重试 */
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const upFiles = useRef<Record<string, File>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const [fullImage, setFullImage] = useState<string | null>(null);
  /** 大图里认出的二维码，交给 ScanFlow 统一处理 */
  const [scanText, setScanText] = useState<string | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [toast, setToast] = useState('');
  /** 没完成资料收集就发消息：弹框带去 AI 红娘 */
  const [needProfile, setNeedProfile] = useState(false);
  const [needKyc, setNeedKyc] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  // 从搜索结果 / 引用 / 置顶跳过来：定位到该消息并闪一下，之后照常滚到底
  const focusId = useRef<string | null>(state.focusMsgId ?? null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const [menu, setMenu] = useState<{ m: MsgItem; x: number; y: number } | null>(null);
  const [replyTo, setReplyTo] = useState<MsgItem | null>(null);
  const replyRef = useRef<MsgItem | null>(null);
  replyRef.current = replyTo;
  const [pins, setPins] = useState<PinItem[]>([]);
  const [pinIdx, setPinIdx] = useState(0);
  const [selecting, setSelecting] = useState<Set<string> | null>(null);
  const [forwardIds, setForwardIds] = useState<string[] | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2000);
  };

  const loadPins = () => {
    if (!conversationId) return;
    api<PinItem[]>(`/im/conversations/${conversationId}/pins`).then((l) => { setPins(l); setPinIdx(0); }).catch(() => {});
  };

  const flash = (id: string) => {
    const el = document.getElementById(`msg-${id}`) ?? document.getElementById(`cell-${id}`);
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    setFlashId(id);
    setTimeout(() => setFlashId(null), 1600);
    return true;
  };

  /** 跳到某条消息：不在当前列表就按 aroundId 重新拉一段 */
  const jumpTo = async (id: string) => {
    if (flash(id)) return;
    try {
      focusId.current = id;
      const list = await api<MsgItem[]>(`/im/messages?conversationId=${conversationId}&aroundId=${id}`);
      if (!list.some((m) => m.id === id)) {
        focusId.current = null;
        showToast(t('msg.originalGone'));
        return;
      }
      setMessages(list);
      setTimeout(() => { if (focusId.current === id && flash(id)) focusId.current = null; }, 80);
    } catch {
      focusId.current = null;
    }
  };

  useEffect(() => {
    if (!conversationId) return;
    const around = state.focusMsgId ? `&aroundId=${state.focusMsgId}` : '';
    api<MsgItem[]>(`/im/messages?conversationId=${conversationId}${around}`).then((list) => {
      // 列表回来之前就发出 / 收到的消息不能被覆盖掉
      setMessages((prev) => {
        const ids = new Set(list.map((m) => m.id));
        return [...list, ...prev.filter((m) => !ids.has(m.id))];
      });
      const last = list[list.length - 1];
      if (last) wsManager.markRead(conversationId, last.id);
    }).catch(() => {});
    loadPins();

    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'match') {
        // 互相喜欢了 / 对方结束了聊天：马上换成能发 / 不能发
        loadRel();
      } else if (frame.op === 'msg') {
        const m = frame.data as MessagePayload;
        if (m.conversationId === conversationId) {
          setMessages((prev) => [...prev, m]);
          wsManager.markRead(conversationId, m.id);
        }
      } else if (frame.op === 'msg_delete' && frame.data?.conversationId === conversationId) {
        const mid = String(frame.data.msgId);
        setPins((prev) => prev.filter((p) => p.id !== mid));
        setMessages((prev) => prev.filter((m) => m.id !== mid));
      } else if (frame.op === 'msg_reactions' && frame.data?.conversationId === conversationId) {
        const d = frame.data;
        setMessages((prev) => prev.map((m) => (m.id === d.msgId ? { ...m, reactions: d.reactions } : m)));
      } else if (frame.op === 'msg_pin' && frame.data?.conversationId === conversationId) {
        loadPins();
      } else if (frame.op === 'conv_cleared') {
        // 有人清空了记录：重新拉取同步
        if (frame.data?.conversationId === conversationId) {
          api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`)
            .then((list) => setMessages(list))
            .catch(() => {});
        }
      } else if (frame.op === 'ack') {
        setMessages((prev) => prev.map((m) => (
          m.tempId === frame.tempId ? { ...m, id: frame.msgId, createdAt: frame.createdAt, pending: false } : m
        )));
      } else if (frame.op === 'error') {
        // 发送被后端拒绝：撤回乐观显示的消息，提示一下。
        // 2026-11-27 起发消息放开了，服务器不会再因为没填资料 / 没认证 / 没互相喜欢拒绝（need_profile、need_kyc 两个分支留着兜底）
        setMessages((prev) => prev.filter((m) => !(m.pending && m.tempId && (frame.tempId ? m.tempId === frame.tempId : true))));
        if (frame.code === 'need_profile') setNeedProfile(true);
        else if (frame.code === 'need_kyc') setNeedKyc(true);
        else {
          showToast(frame.msg ?? t('msg.sendFailed'));
          // 对方已结束聊天：输入区换成提示
          if (frame.code === 'chat_ended') loadRel();
        }
      } else if (frame.op === 'read' && frame.conversationId === conversationId) {
        // 对方已读：把我发出的、id 不大于回执 msgId 的消息标记为已读
        const readUpTo = BigInt(frame.msgId);
        setMessages((prev) => prev.map((m) => {
          if (m.pending || !me || m.senderId !== me.id) return m;
          try {
            return BigInt(m.id) <= readUpTo ? { ...m, isRead: true } : m;
          } catch {
            return m;
          }
        }));
      }
    });
  }, [conversationId]);

  useEffect(() => {
    if (focusId.current) {
      if (!messages.length) return;
      const id = focusId.current;
      focusId.current = null;
      if (flash(id)) return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const sendRaw = (msgType: string, content: string) => {
    if (!state.targetId || !me) return;
    // 一次回复只挂在紧接着发的第一条上（多图连发时后面的不带）
    const r = replyRef.current;
    replyRef.current = null;
    if (r) setReplyTo(null);
    const tempId = wsManager.send(state.targetId, msgType, content, r?.id);
    setMessages((prev) => [...prev, {
      id: tempId, tempId, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar,
      type: msgType, content, createdAt: new Date().toISOString(), pending: true,
      replyTo: r ? replyPreview(r) : null,
    }]);
  };

  const replyPreview = (r: MsgItem): ReplyPreview => ({
    id: r.id, senderId: r.senderId, senderNickname: r.senderNickname, type: r.type,
    content: r.type === 'text' ? r.content.slice(0, 100) : r.type === 'image' ? imageUrl(r.content) : '',
  });

  const setUpload = (key: string, s: UploadState | null) => setUploads((u) => {
    const n = { ...u };
    if (s) n[key] = s; else delete n[key];
    return n;
  });

  /** 上传一张本地图；成功返回地址，失败标红等重试 */
  const uploadOne = async (key: string): Promise<string | null> => {
    const file = upFiles.current[key];
    if (!file) return null;
    setUpload(key, { progress: 0 });
    try {
      const blob = await shrinkImage(file);
      let last = 0;
      const url = await uploadBlob('image', blob, 'img.jpg', (p) => {
        if (p - last < 0.02 && p < 1) return;
        last = p;
        setUpload(key, { progress: p });
      });
      setUpload(key, null);
      return url;
    } catch {
      setUpload(key, { failed: true });
      return null;
    }
  };

  /** 传完的图发出去：本地那条换成 tempId，等 ack */
  const sendUploaded = (key: string, url: string) => {
    const m = messagesRef.current.find((x) => x.upKey === key);
    if (!m || !state.targetId) return;
    const content = imageContent(url, parseImage(m.content));
    const tempId = wsManager.send(state.targetId, 'image', content, m.replyTo?.id);
    setMessages((prev) => prev.map((x) => (x.upKey === key ? { ...x, id: tempId, tempId, content } : x)));
    delete upFiles.current[key];
    return wsManager.waitAck(tempId);
  };

  /** 选好的图立刻显示（本地预览 + 进度圈），后台最多同时传 3 张，按选择顺序发出；多张合成一个相册 */
  const sendImages = async (files: File[]) => {
    if (!me || !files.length) return;
    const g = files.length > 1 ? newAlbumId() : undefined;
    const r = replyRef.current;
    replyRef.current = null;
    if (r) setReplyTo(null);
    const items = await Promise.all(files.map(async (file, i) => {
      const local = URL.createObjectURL(file);
      const { w, h } = await readImageSize(local);
      const key = `l_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
      upFiles.current[key] = file;
      return { key, local, w, h };
    }));
    const now = new Date().toISOString();
    setMessages((prev) => [...prev, ...items.map((it, i): MsgItem => ({
      id: it.key, upKey: it.key, local: it.local, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar,
      type: 'image', content: imageContent('', { g, w: it.w, h: it.h }), createdAt: now, pending: true,
      replyTo: i === 0 && r ? replyPreview(r) : null,
    }))]);
    setUploads((u) => ({ ...u, ...Object.fromEntries(items.map((it) => [it.key, { progress: 0 }])) }));
    await uploadInOrder(items.map((it) => it.key), uploadOne, sendUploaded);
  };

  const retryUpload = async (m: MsgItem) => {
    if (!m.upKey) return;
    if (m.type === 'file' || m.type === 'video') {
      const c = await uploadPicked(m.upKey);
      if (c) sendPicked(m.upKey, c);
      return;
    }
    const url = await uploadOne(m.upKey);
    if (url) sendUploaded(m.upKey, url);
  };

  /** 「文件」里选的视频 / 文件：传完返回消息 content（视频是地址，文件是 { url, name, size, mime }） */
  const uploadPicked = async (key: string): Promise<string | null> => {
    const file = upFiles.current[key];
    const m = messagesRef.current.find((x) => x.upKey === key);
    if (!file || !m) return null;
    setUpload(key, { progress: 0 });
    try {
      let last = 0;
      const onProgress = (p: number) => {
        if (p - last < 0.01 && p < 1) return;
        last = p;
        setUpload(key, { progress: p });
      };
      const content = m.type === 'video' ? await uploadBlob('video', file, file.name, onProgress) : JSON.stringify(await uploadChatFile(file, onProgress));
      setUpload(key, null);
      return content;
    } catch (e: any) {
      setUpload(key, { failed: true });
      showToast(e.message || t('common.uploadFailed'));
      return null;
    }
  };

  const sendPicked = (key: string, content: string) => {
    const m = messagesRef.current.find((x) => x.upKey === key);
    if (!m || !state.targetId) return;
    const tempId = wsManager.send(state.targetId, m.type, content, m.replyTo?.id);
    setMessages((prev) => prev.map((x) => (x.upKey === key ? { ...x, id: tempId, tempId, content } : x)));
    delete upFiles.current[key];
  };

  /**
   * 「文件」里选的，每个一条：图片走发图（压缩、相册），音频按语音发，视频按视频发（带进度），其余按文件发。
   * 视频 / 文件立刻显示带进度的占位，按顺序一个个传。
   */
  const sendFiles = async (files: File[]) => {
    if (!me) return;
    const bad = files.find((f) => f.size > FILE_MAX_SIZE || f.size === 0);
    if (bad) showToast(t(bad.size ? 'chat.file.tooLarge' : 'chat.file.empty', { name: bad.name }));
    const ok = files.filter((f) => f.size > 0 && f.size <= FILE_MAX_SIZE);
    if (!ok.length) return;
    const kinds = await Promise.all(ok.map(async (f) => {
      const k = pickKind(f);
      const d = k === 'audio' ? await audioDuration(f) : 0;
      return { f, d, k: k === 'audio' && !d ? ('file' as PickKind) : k };
    }));
    const images = kinds.filter((x) => x.k === 'image').map((x) => x.f);
    if (images.length) void sendImages(images);

    const picked = kinds.filter((x) => x.k === 'video' || x.k === 'file');
    const r = picked.length ? replyRef.current : null;
    if (r) { replyRef.current = null; setReplyTo(null); }
    const now = new Date().toISOString();
    const items = picked.map((x, i) => {
      const key = `f_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`;
      upFiles.current[key] = x.f;
      return { key, kind: x.k, file: x.f };
    });
    if (items.length) {
      setMessages((prev) => [...prev, ...items.map((it, i): MsgItem => ({
        id: it.key, upKey: it.key, senderId: me.id, senderNickname: me.nickname, senderAvatar: me.avatar,
        type: it.kind, content: it.kind === 'file' ? JSON.stringify({ name: it.file.name, size: it.file.size, mime: it.file.type }) : '',
        createdAt: now, pending: true, replyTo: i === 0 && r ? replyPreview(r) : null,
      }))]);
      setUploads((u) => ({ ...u, ...Object.fromEntries(items.map((it) => [it.key, { progress: 0 }])) }));
    }

    for (const a of kinds.filter((x) => x.k === 'audio')) {
      try {
        const url = await uploadBlob('audio', a.f, a.f.name);
        sendRaw('audio', JSON.stringify({ url, duration: a.d }));
      } catch (e: any) {
        showToast(e.message || t('common.uploadFailed'));
      }
    }
    for (const it of items) {
      const c = await uploadPicked(it.key);
      if (c) sendPicked(it.key, c);
    }
  };

  // 离开页面时释放本地预览
  useEffect(() => () => messagesRef.current.forEach((m) => m.local && URL.revokeObjectURL(m.local)), []);

  const sendVoice = async (blob: Blob, duration: number) => {
    try {
      const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
      const url = await uploadBlob('audio', blob, `voice.${ext}`);
      sendRaw('audio', JSON.stringify({ url, duration }));
    } catch (e: any) {
      showToast(e.message || t('msg.sendFailed'));
    }
  };

  // ---------- 长按菜单 ----------

  const react = async (msgId: string, emoji: string) => {
    try {
      const r = await api<{ reactions: Reaction[] }>(`/im/messages/${msgId}/react`, { method: 'POST', body: { emoji } });
      setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, reactions: r.reactions } : m)));
    } catch (e: any) {
      showToast(e.message || t('common.failed'));
    }
  };

  const togglePin = async (msgId: string, pin: boolean) => {
    try {
      await api(`/im/messages/${msgId}/pin`, { method: 'POST', body: { pin } });
      loadPins();
      showToast(pin ? t('msg.pinned') : t('msg.unpinned'));
    } catch (e: any) {
      showToast(e.message || t('common.failed'));
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => showToast(t('common.copied'))).catch(() => showToast(t('msg.copyFailed')));
  };

  const isMine = (m: MsgItem) => !!me && m.senderId === me.id;

  const menuActions = (m: MsgItem): MenuActions => ({
    onReact: (e) => react(m.id, e),
    onReply: () => { setReplyTo(m); setShowEmoji(false); setTimeout(() => inputRef.current?.focus(), 0); },
    onCopy: m.type === 'text' ? () => copyText(m.content) : undefined,
    onSave: m.type === 'image' || m.type === 'video' ? () => saveMedia(m.type === 'image' ? imageUrl(m.content) : m.content, m.type)
      : m.type === 'file' && parseFile(m.content).url ? () => downloadFile(parseFile(m.content)) : undefined,
    onPin: () => togglePin(m.id, !pins.some((p) => p.id === m.id)),
    onForward: FORWARDABLE.has(m.type) ? () => setForwardIds([m.id]) : undefined,
    onReport: !isMine(m) ? () => setReportId(m.id) : undefined,
    onDelete: () => setDeleteIds([m.id]),
    onSelect: () => setSelecting(new Set([m.id])),
  });

  const doDelete = async (forAll: boolean) => {
    const ids = deleteIds ?? [];
    setDeleteIds(null);
    try {
      await api('/im/messages/delete', { method: 'POST', body: { conversationId, ids, forAll } });
      setSelecting(null);
      setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    } catch (e: any) {
      showToast(e.message || t('msg.deleteFailed'));
    }
  };

  const selected = selecting ? messages.filter((m) => selecting.has(m.id)) : [];
  /** on 不传 = 切换；相册整组勾选时传 on */
  const toggleSelect = (id: string, on?: boolean) => setSelecting((s) => {
    if (!s) return s;
    const n = new Set(s);
    if (on ?? !n.has(id)) n.add(id); else n.delete(id);
    return n;
  });
  const copySelected = () => {
    const texts = selected.filter((m) => m.type === 'text');
    if (!texts.length) return showToast(t('msg.noTextSelected'));
    copyText(texts.map((m) => m.content).join('\n'));
    setSelecting(null);
  };
  const forwardSelected = () => {
    const ok = selected.filter((m) => FORWARDABLE.has(m.type)).map((m) => m.id);
    if (!ok.length) return showToast(t('msg.cantForward'));
    if (ok.length < selected.length) showToast(t('msg.someNotForwarded'));
    setForwardIds(ok);
  };

  const send = () => {
    const content = input.trim();
    if (!content) return;
    sendRaw('text', content);
    setInput('');
  };

  /** 「+」弹框选的图 / 视频：按顺序逐个上传发送，说明文字最后单独发一条 */
  const sendMedia = async (files: File[], caption: string) => {
    const images = files.filter((f) => !f.type.startsWith('video'));
    const videos = files.filter((f) => f.type.startsWith('video'));
    const imagesDone = sendImages(images);
    let failed = 0;
    for (const file of videos) {
      try {
        sendRaw('video', await uploadFile('video', file));
      } catch {
        failed++;
      }
    }
    await imagesDone;
    if (caption.trim()) sendRaw('text', caption.trim());
    if (failed) showToast(t('msg.filesFailed', { n: failed }));
  };

  const handleAttach = (a: AttachAction) => {
    if (a === 'location') sendLocation();
    else setShowDownload(true);
  };

  const sendLocation = () => {
    if (!navigator.geolocation) return alert(t('msg.locUnsupported'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        sendRaw('location', JSON.stringify({ lat: latitude, lng: longitude, name: nearestCity(latitude, longitude) }));
      },
      () => alert(t('msg.locFailed')),
    );
  };

  return (
    <div className="app">
      <div className="navbar">
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <span className="title ellipsis">{state.title ?? t('chat.title')}</span>
        <span className="nav-more">
          <span className="nav-more-btn" onClick={() => setNavMenu(true)}>···</span>
          {navMenu && (
            <>
              <div className="nav-menu-mask" onClick={() => setNavMenu(false)} />
              <div className="nav-menu">
                {state.targetId && <div onClick={() => { setNavMenu(false); nav(`/u/${state.targetId}`); }}>看 TA 的画像</div>}
                {state.targetId && <div onClick={() => { setNavMenu(false); setReporting(true); }}>举报</div>}
                {/* 任何时候都能点（2026-11-27 起谁都能先发消息，这是不想被打扰时唯一的办法）；自己已经点过的不再显示 */}
                {state.targetId && rel && rel.endedBy !== 'me' && (
                  <div
                    className="danger"
                    onClick={async () => {
                      setNavMenu(false);
                      if (!window.confirm('确定不再联系？\n之后你们都不能再给对方发消息，这个聊天会从列表里收起，也不再互相推荐。对方只会看到「对方已结束聊天」。')) return;
                      try {
                        await api(`/match/end/${state.targetId}`, { method: 'POST' });
                        nav(-1);
                      } catch (e: any) {
                        alert(e.message);
                      }
                    }}
                  >
                    不合适，不再联系
                  </div>
                )}
                <div
                  className="danger"
                  onClick={async () => {
                    setNavMenu(false);
                    if (!window.confirm(t('chat.clearConfirmDirect'))) return;
                    try {
                      await api(`/im/conversations/${conversationId}/clear`, { method: 'POST' });
                      const list = await api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`);
                      setMessages(list);
                    } catch (e: any) {
                      alert(e.message);
                    }
                  }}
                >
                  {t('chat.menu.clear')}
                </div>
              </div>
            </>
          )}
        </span>
      </div>
      {pins.length > 0 && (
        <PinBar
          pins={pins}
          index={pinIdx}
          onJump={() => { jumpTo(pins[pinIdx % pins.length].id); setPinIdx((i) => (i + 1) % pins.length); }}
          onUnpin={() => { const p = pins[pinIdx % pins.length]; if (confirm(t('msg.unpinConfirm'))) togglePin(p.id, false); }}
        />
      )}

      <div className="page page-pad" onClick={() => setShowEmoji(false)}>
        {/* 顶上一条提示 + 防骗提醒：互相喜欢了写哪天配上的；还没互相喜欢的照常能聊（样稿 design/09-openchat.html） */}
        {rel?.state === 'mutual' && (
          <div className="hn-tip" style={{ margin: '6px 0 14px', background: 'rgba(0,0,0,0.04)' }}>
            {rel.matchedAt ? `你们在 ${matchDay(rel.matchedAt)}互相喜欢了。` : '你们互相喜欢了。'}<br />线下见面前不要转账，遇到借钱、投资的请直接举报。
          </div>
        )}
        {rel && rel.state !== 'mutual' && rel.state !== 'ended' && (
          <div className="hn-tip" style={{ margin: '6px 0 14px', background: 'rgba(0,0,0,0.04)' }}>
            你们还没有互相喜欢，可以先聊聊。<br />线下见面前不要转账，遇到借钱、投资的请直接举报。
          </div>
        )}
        {(() => {
          let idx = 0;
          return groupAlbums(messages).map((row) => {
            const m = row[0];
            const i = idx;
            idx += row.length;
            const album = row.length > 1 ? row : undefined;
            // 微信式时间分隔条：与上一条间隔超 5 分钟显示
            const prev = i > 0 ? new Date(messages[i - 1].createdAt).getTime() : 0;
            const cur = new Date(m.createdAt).getTime();
            const showTime = !!m.createdAt && !Number.isNaN(cur) && (i === 0 || cur - prev > 5 * 60 * 1000);
            const g = album ? parseImage(m.content).g : undefined;
            const allSel = !!selecting && row.every((x) => selecting.has(x.id));
            return (
              <div key={g ? `g_${g}` : m.tempId ?? m.upKey ?? m.id} id={`msg-${m.id}`} className={flashId && row.some((x) => x.id === flashId) ? 'msg-flash' : undefined}>
                {showTime && (
                  <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-3)', padding: '8px 0' }}>
                    {formatTime(m.createdAt)}
                  </div>
                )}
                {selecting ? (
                  <div className="sel-row" onClick={() => !row.some((x) => x.pending) && row.forEach((x) => toggleSelect(x.id, !allSel))}>
                    <span className={`sel-circle${allSel ? ' on' : ''}`}>{allSel ? '✓' : ''}</span>
                    <MsgBubble m={m} album={album} mine={isMine(m)} myId={me?.id} uploads={uploads} onImage={() => {}} onMenu={() => {}} onReact={() => {}} onJump={() => {}} />
                  </div>
                ) : (
                  <MsgBubble
                    m={m}
                    album={album}
                    mine={isMine(m)}
                    myId={me?.id}
                    uploads={uploads}
                    onImage={setFullImage}
                    onMenu={(x, y, target) => {
                      const tm = target ?? m;
                      if (!tm.pending) setMenu({ m: tm, x, y });
                    }}
                    onReact={(e, target) => react((target ?? m).id, e)}
                    onJump={jumpTo}
                    onRetry={retryUpload}
                  />
                )}
              </div>
            );
          });
        })()}
        <div ref={bottomRef} />
      </div>

      {/* 底部输入区（微信式，对齐 iOS）：输入框 + 圆形加号呼出功能面板，发送键仅有文字时出现 */}
      {selecting ? (
        <div className="sel-bar">
          <span onClick={() => setSelecting(null)}>{t('common.cancel')}</span>
          <span className="grow small" style={{ cursor: 'default' }}>{t('msg.selectedN', { n: selecting.size })}</span>
          <span className={selected.length ? '' : 'off'} onClick={() => selected.length && copySelected()}>{t('msg.copy')}</span>
          <span className={selected.length ? '' : 'off'} onClick={() => selected.length && forwardSelected()}>{t('msg.forward')}</span>
          <span className={selected.length ? '' : 'off'} style={selected.length ? { color: 'var(--danger)' } : undefined} onClick={() => selected.length && setDeleteIds(selected.map((m) => m.id))}>{t('common.delete')}</span>
        </div>
      ) : rel && rel.state === 'ended' ? (
        // 有一方点了「不再联系」：输入区换成一句说明，聊天记录照常能看。其余情况一律能发（发消息已经放开）
        <div style={{ background: 'var(--bg-card)', padding: '14px 16px calc(14px + env(safe-area-inset-bottom))', textAlign: 'center', fontSize: 14, color: 'var(--text-2)', lineHeight: 1.6 }}>
          {rel.endedBy === 'me' ? '你已选择不再联系' : '对方已结束聊天'}
        </div>
      ) : (
      <div style={{ background: 'var(--bg-card)', position: 'relative' }}>
        {replyTo && <ReplyBar m={replyTo} onCancel={() => setReplyTo(null)} />}
        <div className="row" style={{ padding: 8, gap: 8 }}>
          <span
            title={voiceMode ? t('chat.voice.keyboard') : t('msg.voice')}
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)' }}
            onClick={() => { setVoiceMode((v) => !v); setShowEmoji(false); if (voiceMode) setTimeout(() => inputRef.current?.focus(), 0); }}
          >
            {voiceMode ? <KeyboardGlyph /> : <span className="voice-bars"><span /><span /><span /></span>}
          </span>
          {voiceMode ? (
            <VoiceHoldButton onSend={sendVoice} onError={showToast} />
          ) : (
            <input
              ref={inputRef}
              className="input grow"
              style={{ marginBottom: 0, borderRadius: 20, height: 40 }}
              value={input}
              placeholder={t('chat.inputPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setShowEmoji(false)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
          )}
          <span
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: showEmoji ? '#ffe1e7' : 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: showEmoji ? 'var(--accent)' : 'var(--text-2)', fontSize: 22 }}
            onClick={() => { setShowEmoji((v) => !v); setVoiceMode(false); }}
          >☺</span>
          <span
            style={{ width: 40, height: 40, borderRadius: 20, flexShrink: 0, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)', fontSize: 20 }}
            onClick={() => { setShowAttach(true); setShowEmoji(false); }}
          >+</span>
          {input.trim() && !voiceMode && (
            <button className="btn-sm" style={{ height: 40, borderRadius: 20, flexShrink: 0 }} onClick={send}>{t('common.send')}</button>
          )}
        </div>
        {showEmoji && (
          <EmojiPanel
            onEmoji={(e) => setInput((v) => v + e)}
            onDelete={() => setInput((v) => dropLastGrapheme(v))}
            onKeyboard={() => { setShowEmoji(false); inputRef.current?.focus(); }}
          />
        )}
      </div>
      )}

      {reporting && state.targetId && <UserReportSheet userId={state.targetId} onClose={() => setReporting(false)} onDone={showToast} />}
      {needProfile && (
        <div className="mask" onClick={() => setNeedProfile(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{t('hn.needTitle')}</h3>
            <p>{t('hn.needBody')}</p>
            <button className="btn" onClick={() => { setNeedProfile(false); nav('/interview'); }}>{t('hn.needGo')}</button>
            <div className="muted" style={{ marginTop: 14, fontSize: 14, cursor: 'pointer' }} onClick={() => setNeedProfile(false)}>{t('common.cancel')}</div>
          </div>
        </div>
      )}
      {needKyc && (
        <div className="mask" onClick={() => setNeedKyc(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>先完成实人认证</h3>
            <p>发消息前需要做实人认证（身份证 + 刷脸），¥1 从 AI 余额扣。</p>
            <button className="btn" onClick={() => { setNeedKyc(false); nav(`/kyc?next=${encodeURIComponent('/chatroom/' + conversationId)}`); }}>去认证</button>
            <div className="muted" style={{ marginTop: 14, fontSize: 14, cursor: 'pointer' }} onClick={() => setNeedKyc(false)}>以后再说</div>
          </div>
        </div>
      )}

      {showAttach && (
        <AttachSheet
          canVideoCall
          onClose={() => setShowAttach(false)}
          onSend={sendMedia}
          onFiles={sendFiles}
          onAction={handleAttach}
        />
      )}
      {toast && (
        <div style={{ position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 200, background: 'rgba(0,0,0,0.8)', color: '#fff', fontSize: 14, padding: '10px 18px', borderRadius: 20, whiteSpace: 'nowrap' }}>
          {toast}
        </div>
      )}
      {fullImage && (
        <div
          className="mask"
          style={{ background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setFullImage(null)}
        >
          <img src={fullImage} alt="" style={{ maxWidth: '100vw', maxHeight: '100vh', objectFit: 'contain' }} />
          <span
            style={{ position: 'fixed', top: 16, right: 16, width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.15)', color: '#fff', fontSize: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >×</span>
          <span
            onClick={async (e) => {
              e.stopPropagation();
              if (qrBusy) return;
              setQrBusy(true);
              const text = await decodeQrFromImage(fullImage).catch(() => null);
              setQrBusy(false);
              if (!text) return showToast(t('chat.noQrFound'));
              setFullImage(null);
              setScanText(text);
            }}
            style={{ position: 'fixed', bottom: 48, left: '50%', transform: 'translateX(-50%)', padding: '9px 16px', borderRadius: 20, background: 'rgba(255,255,255,0.18)', color: '#fff', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            <ScanIcon size={16} color="#fff" />
            {qrBusy ? t('chat.qrScanning') : t('chat.scanQr')}
          </span>
        </div>
      )}
      {scanText && <ScanFlow text={scanText} onClose={() => setScanText(null)} />}
      {menu && (
        <MsgMenu
          m={menu.m}
          mine={isMine(menu.m)}
          myReaction={menu.m.reactions?.find((r) => me && r.userIds.includes(me.id))?.emoji}
          pinned={pins.some((p) => p.id === menu.m.id)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          actions={menuActions(menu.m)}
        />
      )}
      {deleteIds && (
        <DeleteDialog
          count={deleteIds.length}
          canForAll={messages.filter((m) => deleteIds.includes(m.id)).every(isMine)}
          peerName={state.title}
          onConfirm={doDelete}
          onClose={() => setDeleteIds(null)}
        />
      )}
      {forwardIds && conversationId && (
        <ForwardSheet
          fromConversationId={conversationId}
          ids={forwardIds}
          onClose={() => setForwardIds(null)}
          onDone={(tip, convIds) => {
            setForwardIds(null);
            setSelecting(null);
            showToast(tip);
            if (convIds.includes(conversationId)) {
              api<MsgItem[]>(`/im/messages?conversationId=${conversationId}`).then(setMessages).catch(() => {});
            }
          }}
        />
      )}
      {reportId && (
        <ReportSheet msgId={reportId} onClose={() => setReportId(null)} onDone={(tip) => { setReportId(null); showToast(tip); }} />
      )}
      {showDownload && <DownloadDialog onClose={() => setShowDownload(false)} />}
    </div>
  );
}
