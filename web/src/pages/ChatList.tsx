import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { openNativeChat } from '../bridge';
import { fileSnippet } from '../components/ChatMedia';
import { api } from '../api';
import { wsManager } from '../ws';
import { ChatSearch } from '../components/ChatSearch';
import { parseInviteCode, QrScanner, ScanIcon } from '../components/QrScanner';
import { t } from '../i18n';
import { MatchSummary } from '../match';
import '../hn.css';

interface ConversationItem {
  id: string;
  peer?: { id: string; nickname: string; avatar: string; gender: number };
  lastMsg?: { type: string; content: string; createdAt: string } | null;
  unread: number;
  muted?: boolean;
  lastMsgAt: string;
  /** 互相喜欢的才有：fresh = 刚配上还没说过话 */
  match?: { at: string | null; fresh: boolean } | null;
  /** 对方点了「不合适，不再联系」 */
  ended?: boolean;
}

function previewText(msg?: ConversationItem['lastMsg']): string {
  if (!msg) return '';
  switch (msg.type) {
    case 'text': return msg.content.slice(0, 30);
    case 'image': return t('msg.preview.image');
    case 'video': return t('msg.preview.video');
    case 'audio': return t('msg.preview.voice');
    case 'file': return fileSnippet(msg.content);
    case 'location': return t('msg.preview.location');
    default: return msg.type.startsWith('call') ? t('msg.preview.call') : '';
  }
}

function timeText(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 扫到的二维码统一在这里处理（消息页搜索 / 我的页的扫一扫、聊天图片「识别二维码」共用）：
 * 邀请名片 → 直接打开与对方的私聊；其它内容提示无法识别。
 * 传了 text 就不开相机，直接处理这段内容。
 */
export function ScanFlow({ onClose, text: given }: { onClose: () => void; text?: string }) {
  const nav = useNavigate();
  const [scanning, setScanning] = useState(given == null);
  const started = useRef(false);
  useEffect(() => {
    if (given == null || started.current) return;
    started.current = true;
    void handle(given);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [given]);

  const handle = async (raw: string) => {
    setScanning(false);
    const text = raw.trim();
    const invite = parseInviteCode(text);
    if (invite) {
      try {
        const r = await api<{ conversationId: string; peer: { id: string; nickname: string } }>(
          '/im/conversations/open-by-code', { method: 'POST', body: { code: invite } },
        );
        onClose();
        if (openNativeChat(r.conversationId, 1, r.peer.id, r.peer.nickname)) return;
        nav(`/chatroom/${r.conversationId}`, { state: { title: r.peer.nickname, targetId: r.peer.id } });
      } catch (e: any) {
        alert(e.message);
        onClose();
      }
      return;
    }
    alert(t('scan.unknownQr'));
    onClose();
  };

  return scanning ? <QrScanner hint={t('scan.hintInvite')} onResult={handle} onClose={onClose} /> : null;
}

export function ChatListPage() {
  const nav = useNavigate();
  const [convs, setConvs] = useState<ConversationItem[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [showScan, setShowScan] = useState(false);

  /** 顶上三个数字：喜欢我的 / 我喜欢的 / 互相喜欢 */
  const [sum, setSum] = useState<MatchSummary | null>(null);

  const loadConvs = () => api<ConversationItem[]>('/im/conversations').then(setConvs).catch(() => {});
  const loadSum = () => api<MatchSummary>('/match/summary').then(setSum).catch(() => {});

  useEffect(() => {
    loadConvs();
    loadSum();
    wsManager.connect();
    return wsManager.on((frame) => {
      if (frame.op === 'msg' || frame.op === 'conv_cleared' || frame.op === 'conv_refresh') loadConvs();
      // 有人喜欢了我 / 互相喜欢了 / 对方结束了聊天：数字和列表都刷新
      if (frame.op === 'match') { loadSum(); loadConvs(); }
    });
  }, []);

  const openConv = (c: { id: string; targetId: string; title: string; focusMsgId?: string }) => {
    if (openNativeChat(c.id, 1, c.targetId, c.title)) return;
    nav(`/chatroom/${c.id}`, { state: { title: c.title, targetId: c.targetId, focusMsgId: c.focusMsgId } });
  };

  // 会话按最新消息时间排，最新的在上
  const entries = [...convs].sort((a, b) => new Date(b.lastMsgAt).getTime() - new Date(a.lastMsgAt).getTime());

  return (
    <>
      <div className="cl-head">
        <span className="cl-title">{t('tab.messages')}</span>
      </div>

      {/* 搜索：点了弹全屏搜索框 */}
      <div className="cl-search" onClick={() => setShowSearch(true)}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        {t('common.search')}
        <span className="cl-scan" title={t('me.scan')} onClick={(e) => { e.stopPropagation(); setShowScan(true); }}>
          <ScanIcon size={17} color="currentColor" />
        </span>
      </div>

      {/* 喜欢我的 / 我喜欢的 / 互相喜欢：点哪个进喜欢列表对应的分类 */}
      <div className="hn-ents" style={{ paddingTop: 8 }}>
        {([['likedMe', '喜欢我的', sum?.likedMe], ['liked', '我喜欢的', sum?.liked], ['mutual', '互相喜欢', sum?.mutual]] as const).map(([k, label, n]) => (
          <div key={k} className="hn-ent hn-glass" onClick={() => nav(`/likes?tab=${k}`)}>
            <div className="num" style={k === 'likedMe' && n ? { color: 'var(--hn-rose)' } : undefined}>{n ?? '-'}</div>
            <div className="hn-t2" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
            {k === 'likedMe' && !!sum?.likedMeNew && <span className="new" />}
          </div>
        ))}
      </div>

      {entries.map((c) => {
        const title = c.peer?.nickname ?? '';
        const avatar = c.peer?.avatar;
        const targetId = c.peer?.id ?? '';
        return (
          <div key={c.id} className="cl-row" onClick={() => openConv({ id: c.id, targetId, title })}>
            <div className="avatar" style={{ width: 54, height: 54 }}>
              {avatar && <img src={avatar} alt="" />}
            </div>
            <div className="cl-row-main">
              <div className="cl-row-top">
                <span className="cl-row-title ellipsis" style={c.match?.fresh ? { flex: '0 1 auto' } : undefined}>{title}</span>
                {c.match?.fresh && <span className="hn-tag" style={{ height: 20, fontSize: 10.5, padding: '0 8px', marginLeft: 6, flexShrink: 0 }}>刚配上</span>}
                <span className="small" style={{ marginLeft: 'auto' }}>{timeText(c.lastMsgAt)}</span>
              </div>
              <div className="cl-row-sub">
                <span className="ellipsis">{c.match?.fresh ? '你们互相喜欢了，打个招呼吧' : c.ended && !c.lastMsg ? '对方已结束聊天' : previewText(c.lastMsg)}</span>
                {c.match?.fresh && c.unread === 0 && <span className="cs-badge">新</span>}
                {c.unread > 0 && <span className={`cs-badge${c.muted ? ' muted' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
              </div>
            </div>
          </div>
        );
      })}
      {entries.length === 0 && <div className="empty">还没有聊天。互相喜欢以后，对方会出现在这里。</div>}

      {showSearch && (
        <ChatSearch
          convs={convs}
          extras={[]}
          onClose={() => setShowSearch(false)}
          onOpenConv={(c) => { setShowSearch(false); openConv(c); }}
          onOpenUser={async (id, nickname) => {
            setShowSearch(false);
            try {
              const r = await api<{ conversationId: string }>(`/im/conversations/open/${id}`, { method: 'POST' });
              openConv({ id: r.conversationId, targetId: id, title: nickname });
            } catch (e: any) {
              alert(e.message);
            }
          }}
          onScan={() => { setShowSearch(false); setShowScan(true); }}
        />
      )}
      {showScan && <ScanFlow onClose={() => setShowScan(false)} />}
    </>
  );
}
