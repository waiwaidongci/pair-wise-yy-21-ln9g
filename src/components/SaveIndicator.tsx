import { useEffect, useState } from 'react';
import { saveManager } from '../stores/persistence';
import type { SaveSnapshot } from '../stores/persistence';

const INITIAL: SaveSnapshot = {
  phase: 'idle',
  pendingOpId: null,
  lastSavedOpId: null,
  attempts: 0,
  error: null,
  savedAt: null,
};

/** 写盘状态指示：保存中 / 失败按操作号重试 / 已保存。重复提交不会产生新操作。 */
export function SaveIndicator() {
  const [snapshot, setSnapshot] = useState<SaveSnapshot>(INITIAL);

  useEffect(() => saveManager.subscribe(setSnapshot), []);

  const label = (() => {
    switch (snapshot.phase) {
      case 'saving':
        return { dot: 'is-saving', text: '正在写盘…' };
      case 'retrying':
        return {
          dot: 'is-error',
          text: `写盘失败（操作 ${snapshot.pendingOpId ?? '—'}），${snapshot.attempts} 次重试中…`,
        };
      case 'saved':
        return { dot: 'is-saved', text: '已写盘' };
      default:
        return { dot: '', text: '自动保存就绪' };
    }
  })();

  return (
    <span className="save-state" title={snapshot.error ?? undefined}>
      <span className={`save-state__dot ${label.dot}`} />
      {label.text}
      {snapshot.phase === 'retrying' && (
        <button
          type="button"
          className="save-retry"
          onClick={() => {
            void saveManager.flush();
          }}
        >
          立即重试
        </button>
      )}
    </span>
  );
}
