import { useEffect, useRef } from 'react';

/**
 * Runs `handler` when `key` is pressed anywhere on the page (e.g. 'F2',
 * 'ctrl+s'). The latest handler is always used without re-subscribing.
 */
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const want = key.toLowerCase().split('+');
    const k = want[want.length - 1];
    const ctrl = want.includes('ctrl');
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === k && e.ctrlKey === ctrl) {
        e.preventDefault();
        ref.current(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, enabled]);
}
