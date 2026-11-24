import { useEffect, useMemo, useRef, useState } from 'react';
import { addRecentEmoji, searchEmojis, useEmojis } from '../../emojis';
import { baseEmoji, QUICK_EMOJIS, SearchIcon } from './shared';
import { t } from '../../i18n';

/**
 * 搜索 sheet 外壳：顶部搜索框（自动聚焦）+「完成」，
 * 下面一行快捷 emoji（点了当搜索词），再下面是结果区。
 */
function SheetShell({ placeholder, query, onQuery, onClose, autoFocus = true, children }: { placeholder: string; query: string; onQuery: (q: string) => void; onClose: () => void; autoFocus?: boolean; children: React.ReactNode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) setTimeout(() => inputRef.current?.focus(), 80); }, [autoFocus]);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 400, background: 'rgba(0,0,0,0.35)' }} onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div
        className="sheet-up"
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '86%', background: 'var(--bg)', borderRadius: '16px 16px 0 0', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <div className="row" style={{ padding: '12px 12px 6px', gap: 10 }}>
          <div className="row grow" style={{ background: 'var(--bg-input)', borderRadius: 10, height: 36, padding: '0 10px', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', display: 'flex' }}><SearchIcon size={15} /></span>
            <input ref={inputRef} value={query} onChange={(e) => onQuery(e.target.value)} placeholder={placeholder} style={{ border: 0, outline: 0, background: 'transparent', fontSize: 15, flex: 1, color: 'var(--text)' }} />
            {query && <span onClick={() => { onQuery(''); inputRef.current?.focus(); }} style={{ fontSize: 13, color: 'var(--text-3)', cursor: 'pointer' }}>✕</span>}
          </div>
          <span className="accent" style={{ fontSize: 16, cursor: 'pointer', flexShrink: 0 }} onClick={onClose}>{t('common.done')}</span>
        </div>
        <div className="no-scrollbar" style={{ display: 'flex', gap: 4, padding: '2px 12px 8px', overflowX: 'auto' }}>
          {QUICK_EMOJIS.map((e) => {
            const on = baseEmoji(query.trim()) === baseEmoji(e);
            return (
              <span key={e} onClick={() => onQuery(on ? '' : e)} style={{ fontSize: 22, lineHeight: '36px', width: 36, textAlign: 'center', flexShrink: 0, cursor: 'pointer', borderRadius: 18, background: on ? 'var(--bg-input)' : 'transparent', filter: on ? undefined : 'grayscale(1)', opacity: on ? 1 : 0.5 }}>{e}</span>
            );
          })}
        </div>
        <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

/** 表情搜索 sheet：按中英文关键词 / emoji 本身搜；点了插进输入框，sheet 不关（可连续点几个），「完成」收起。打开时不自动弹键盘（先看最近使用 / 快捷 emoji，要搜再点输入框） */
export function EmojiSearchSheet({ initialQuery, onEmoji, onClose }: { initialQuery: string; onEmoji: (e: string) => void; onClose: () => void }) {
  const { groups, recent } = useEmojis();
  const [q, setQ] = useState(initialQuery);
  const query = q.trim();
  const results = useMemo(() => (query ? searchEmojis(groups, query).map((r) => r[0]) : recent), [groups, query, recent]);

  return (
    <SheetShell placeholder={t('emoji.searchEmoji')} query={q} onQuery={setQ} onClose={onClose} autoFocus={false}>
      {!query && recent.length > 0 && <div className="small" style={{ padding: '2px 12px 4px' }}>{t('emoji.recent')}</div>}
      {results.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', padding: '0 6px' }}>
          {results.map((e, i) => (
            <span key={`${e}-${i}`} onClick={() => { onEmoji(e); addRecentEmoji(e); }} style={{ textAlign: 'center', fontSize: 26, lineHeight: '42px', cursor: 'pointer', userSelect: 'none' }}>{e}</span>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ padding: 30, fontSize: 13 }}>{query ? t('emoji.noMatch') : t('emoji.searchHint')}</div>
      )}
      <div style={{ height: 30 }} />
    </SheetShell>
  );
}
