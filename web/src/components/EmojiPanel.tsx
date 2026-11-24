import { useState } from 'react';
import { EmojiPane } from './emoji-panel/EmojiPane';
import { EmojiSearchSheet } from './emoji-panel/SearchSheets';
import { defaultPanelHeight, useScrollChrome } from './emoji-panel/shared';
import { t } from '../i18n';

/**
 * 表情面板（Telegram 式，三端同一套）：内容往下滚时底部按钮和顶部条一起收起、往上滚回来。
 * 点了插进输入框（onEmoji），左 🌐 切回键盘（onKeyboard），右 ⌫ 删一个字（onDelete）
 */
export function EmojiPanel({ onEmoji, onDelete, onKeyboard, height }: {
  onEmoji?: (e: string) => void;
  onDelete?: () => void;
  onKeyboard?: () => void;
  height?: number;
}) {
  /** 表情搜索 sheet。有值 = 从搜索行进来（'' 只聚焦搜索框，emoji 直接带着搜） */
  const [search, setSearch] = useState<string | null>(null);
  const { hidden, onScroll } = useScrollChrome();
  const h = height ?? defaultPanelHeight();

  return (
    <div style={{ height: h, position: 'relative', background: 'var(--bg-card)', borderTop: '1px solid var(--line)', overflow: 'hidden' }} onClick={(e) => e.stopPropagation()}>
      <EmojiPane hidden={hidden} onScroll={onScroll} onEmoji={(e) => onEmoji?.(e)} onSearch={setSearch} />

      {/* 底部悬浮：左 🌐 / 右 ⌫ */}
      {onKeyboard && (
        <div className={`ep-chrome ep-side${hidden ? ' hide' : ''}`} style={{ left: 12 }} title={t('emoji.backToKeyboard')} onClick={onKeyboard}>🌐</div>
      )}
      {onDelete && (
        <div className={`ep-chrome ep-side${hidden ? ' hide' : ''}`} style={{ right: 12 }} title={t('common.delete')} onClick={onDelete}>⌫</div>
      )}

      {search !== null && <EmojiSearchSheet initialQuery={search} onEmoji={(e) => onEmoji?.(e)} onClose={() => setSearch(null)} />}
    </div>
  );
}
