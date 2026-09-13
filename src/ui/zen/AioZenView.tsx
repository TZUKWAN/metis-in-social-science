import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const AIO_HINT_SHOWN_KEY = 'metis:aio-exit-hint-shown';

export interface AioZenViewProps {
  /** ChatPage's `workspace` slot — the SAME conversation runtime, re-presented. */
  workspace: ReactNode;
  onExit: () => void;
  /** i18n strings resolved by the caller. */
  labels: {
    exit: string;
    hint: string;
  };
}

/**
 * AIO Zen presentation (T07): the screen intentionally contains only the
 * conversation viewport and the composer. There is no topbar, no dock, no
 * side panels and no persistent exit control — exit lives on the top hot zone
 * and Ctrl/Cmd+Shift+A. The conversation runtime is owned by the always-mounted
 * ChatPage, so entering/exiting never remounts or resets the session.
 */
export default function AioZenView({ workspace, onExit, labels }: AioZenViewProps) {
  const [exitPillVisible, setExitPillVisible] = useState(false);
  // Shown once per profile: the flag is recorded at first mount so exiting
  // early never nags again. Dismissal is timer-driven, never re-shown.
  const [hintVisible, setHintVisible] = useState(() => {
    try {
      if (window.localStorage.getItem(AIO_HINT_SHOWN_KEY) === '1') return false;
      window.localStorage.setItem(AIO_HINT_SHOWN_KEY, '1');
      return true;
    } catch { return false; }
  });

  useEffect(() => {
    if (!hintVisible) return undefined;
    const timer = window.setTimeout(() => setHintVisible(false), 2000);
    return () => window.clearTimeout(timer);
  }, [hintVisible]);

  return (
    <div className="aio-root" data-testid="aio-root">
      <div className="fx-ambient aio-ambient" aria-hidden="true" />
      <div
        className="aio-conversation"
        data-testid="aio-conversation"
      >
        {workspace}
      </div>
      <div
        className="aio-hotzone"
        data-testid="aio-exit-hotzone"
        onMouseEnter={() => setExitPillVisible(true)}
        onMouseLeave={() => setExitPillVisible(false)}
      >
        {exitPillVisible && (
          <button
            type="button"
            className="aio-exit-pill"
            data-testid="aio-exit"
            onClick={onExit}
          >
            {labels.exit}
          </button>
        )}
      </div>
      {hintVisible && (
        <div className="aio-hint" data-testid="aio-hint" role="status">{labels.hint}</div>
      )}
    </div>
  );
}
