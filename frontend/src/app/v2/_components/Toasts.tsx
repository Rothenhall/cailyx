'use client';

/**
 * Toasts — /v2. A bottom-left stack of short-lived confirmations for actions
 * that finish somewhere other than where they were fired (an audit re-run, a
 * role change, a save). Auto-dismiss; click to dismiss early.
 *
 * @module app/v2/_components/Toasts
 */

import { useCallback, useRef, useState } from 'react';

export interface Toast {
  id: number;
  msg: string;
  tone: 'ok' | 'warn';
}

const LIFE_MS = 3200;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const notify = useCallback(
    (msg: string, tone: 'ok' | 'warn' = 'ok') => {
      const id = next.current++;
      setToasts((t) => [...t.slice(-3), { id, msg, tone }]);
      window.setTimeout(() => dismiss(id), LIFE_MS);
    },
    [dismiss],
  );

  return { toasts, notify, dismiss };
}

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[70] flex flex-col gap-1.5">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onDismiss(t.id)}
          className={`v2-pop pointer-events-auto flex max-w-[320px] items-center gap-2 rounded-r3 border bg-bg-raised/95 px-3 py-2 text-left text-body shadow-[0_18px_44px_-20px_rgba(26,23,18,0.5)] backdrop-blur ${
            t.tone === 'warn' ? 'border-warn/50 text-warn' : 'border-border text-dim'
          }`}
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.tone === 'warn' ? 'bg-warn' : 'bg-accent'}`} />
          <span className="min-w-0 flex-1 truncate">{t.msg}</span>
        </button>
      ))}
    </div>
  );
}
