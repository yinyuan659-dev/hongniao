import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LikePill } from '../match';
import { api, uploadFile } from '../api';
import { MomentItem } from './Plaza';
import { useApp } from '../store';
import { dropLastGrapheme } from '../emojis';
import { EmojiPanel } from '../components/EmojiPanel';
import { t } from '../i18n';

/** 动态详情页：正文 + 全部评论 + 底部固定输入栏 */
export function MomentDetailPage() {
  const nav = useNavigate();
  const me = useApp((s) => s.user);
  const { id } = useParams<{ id: string }>();
  const [moment, setMoment] = useState<MomentItem | null>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [replyTo, setReplyTo] = useState<{ id: string; nickname: string } | null>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLInputElement>(null);

  const loadComments = () => api<any[]>(`/moments/${id}/comments`).then(setComments).catch(() => {});

  useEffect(() => {
    api<MomentItem>(`/moments/${id}`).then((m) => {
      setMoment(m);
      setLiked(m.liked);
      setLikeCount(m.likeCount);
    }).catch((e) => {
      alert(e.message);
      nav(-1);
    });
    loadComments();
  }, [id]);

  const showToast = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(''), 1600);
  };

  const toggleLike = async () => {
    try {
      const r = await api<{ liked: boolean }>(`/moments/${id}/like`, { method: 'POST' });
      setLiked(r.liked);
      setLikeCount((c) => c + (r.liked ? 1 : -1));
    } catch {}
  };

  const send = async (imageUrl?: string) => {
    const content = input.trim();
    if (!content && !imageUrl) return;
    setBusy(true);
    try {
      await api(`/moments/${id}/comments`, { method: 'POST', body: { content, imageUrl, replyToId: replyTo?.id } });
      setInput('');
      setReplyTo(null);
      setShowEmoji(false);
      showToast(t('moments.commentSent'));
      loadComments();
    } catch (e: any) {
      showToast(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendImage = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadFile('image', file);
      await send(url);
    } catch (e: any) {
      showToast(e.message);
      setBusy(false);
    }
  };

  if (!moment) return <div className="app"><div className="empty">{t('common.loading')}</div></div>;

  return (
    <div className="app">
      {/* 顶栏：返回 + 作者 */}
      <div className="navbar" style={{ borderBottom: 'none' }}>
        <span className="back" onClick={() => nav(-1)}>‹</span>
        <div className="avatar" style={{ width: 34, height: 34 }}>
          {moment.user?.avatar && <img src={moment.user.avatar} alt="" />}
        </div>
        <span className="grow" style={{ fontSize: 15 }}>{moment.user?.nickname}</span>
        {/* 原来这里是「私聊」；现在要互相喜欢才能聊，换成喜欢按钮（互相喜欢后它会变成「发消息」）。自己的动态不显示 */}
        {me?.id !== moment.user?.id && moment.user?.id && (
          <LikePill peer={{ id: moment.user.id, nickname: moment.user.nickname }} />
        )}
      </div>

      <div className="page no-scrollbar" style={{ padding: '0 16px' }}>
        {/* 正文 */}
        {moment.content && <div style={{ fontSize: 15, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{moment.content}</div>}
        {moment.type === 1 && moment.images.length > 0 && (
          <div className="grid-photos">{moment.images.map((url, i) => <img key={i} src={url} alt="" />)}</div>
        )}
        {moment.type === 2 && moment.videoUrl && (
          <video
            src={moment.videoUrl}
            poster={moment.coverUrl || undefined}
            controls
            playsInline
            onPlay={(e) => {
              document.querySelectorAll('video').forEach((v) => { if (v !== e.currentTarget) v.pause(); });
            }}
            style={{ width: '100%', borderRadius: 8, marginTop: 10, maxHeight: 420, background: '#000' }}
          />
        )}
        {moment.cityName && (
          <div style={{ marginTop: 10 }}>
            <span className="tag tag-muted">{moment.cityName}</span>
          </div>
        )}
        <div className="small" style={{ marginTop: 8 }}>{new Date(moment.createdAt).toLocaleString('zh-CN')}</div>

        {/* 全部评论 */}
        <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{t('moments.allComments', { n: comments.length })}</div>
          {comments.length === 0 && <div className="empty" style={{ padding: 24 }}>{t('moments.noComments')}</div>}
          {comments.map((c) => (
            <div key={c.id} className="row" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
              <div className="avatar" style={{ width: 34, height: 34 }}>
                {c.user?.avatar && <img src={c.user.avatar} alt="" />}
              </div>
              <div className="grow">
                <div className="small">
                  {c.user?.nickname}
                  {c.replyToNickname && <span> {t('moments.repliedToWeb')} <span className="accent">@{c.replyToNickname}</span></span>}
                </div>
                {c.content && <div style={{ fontSize: 14, marginTop: 3, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{c.content}</div>}
                {c.imageUrl && <img src={c.imageUrl} style={{ maxWidth: 140, borderRadius: 8, marginTop: 4, display: 'block' }} alt="" />}
                <div className="small" style={{ marginTop: 4 }}>
                  {new Date(c.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  <span className="accent" style={{ marginLeft: 12, cursor: 'pointer' }} onClick={() => setReplyTo({ id: c.id, nickname: c.user?.nickname ?? '' })}>{t('moments.reply')}</span>
                </div>
              </div>
            </div>
          ))}
          <div style={{ height: 16 }} />
        </div>
      </div>

      {/* 回复提示条 */}
      {replyTo && (
        <div className="row" style={{ padding: '6px 16px', gap: 10, borderTop: '1px solid var(--line)' }}>
          <span className="small grow">{t('moments.replyingTo')} <span className="accent">@{replyTo.nickname}</span></span>
          <span className="small" style={{ cursor: 'pointer' }} onClick={() => setReplyTo(null)}>{t('common.cancel')}</span>
        </div>
      )}

      {/* 底部固定输入栏 */}
      <div className="row" style={{ padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--line)', gap: 8 }}>
        <span style={{ fontSize: 22, cursor: 'pointer', color: showEmoji ? 'var(--accent)' : 'inherit' }} onClick={() => setShowEmoji((v) => !v)}>☺</span>
        <span
          style={{ width: 30, height: 30, borderRadius: 15, background: 'var(--bg-input)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-2)', flexShrink: 0 }}
          onClick={() => imgRef.current?.click()}
        >+</span>
        <input
          ref={inputRef}
          className="input grow"
          style={{ marginBottom: 0, padding: '10px 14px' }}
          value={input}
          placeholder={replyTo ? t('moments.replyToName', { name: replyTo.nickname }) : t('moments.saySomething')}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => setShowEmoji(false)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
        />
        <span className={liked ? 'accent' : 'muted'} style={{ cursor: 'pointer', fontSize: 13, flexShrink: 0 }} onClick={toggleLike}>
          {t('moments.like')} {likeCount > 0 ? likeCount : ''}
        </span>
        <button className="btn-sm" disabled={busy || !input.trim()} onClick={() => send()}>{t('common.send')}</button>
      </div>

      {/* 表情面板：emoji 插入文字 */}
      {showEmoji && <EmojiPanel onEmoji={(e) => setInput((v) => v + e)} onDelete={() => setInput((v) => dropLastGrapheme(v))} onKeyboard={() => { setShowEmoji(false); inputRef.current?.focus(); }} />}

      <input ref={imgRef} type="file" accept="image/*" hidden onChange={(e) => sendImage(e.target.files)} />
      {toast && (
        <div style={{ position: 'fixed', top: '45%', left: '50%', transform: 'translate(-50%,-50%)', background: 'rgba(0,0,0,0.85)', padding: '10px 22px', borderRadius: 10, fontSize: 14, zIndex: 300 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
