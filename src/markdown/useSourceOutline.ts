import { useEffect, useRef, useState } from 'react';
import { extractMarkdownOutline, type MarkdownOutlineEntry } from './renderMarkdown';

/** Keep outline work outside the source input event and pause it during IME input. */
export function useSourceOutline(content: string, enabled: boolean, session: number, composing: boolean) {
  const [outline, setOutline] = useState<MarkdownOutlineEntry[]>([]);
  const latest = useRef({ content, enabled, session, composing });
  latest.current = { content, enabled, session, composing };
  const previous = useRef({ enabled: false, session: -1 });
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const maximum = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const first = !previous.current.enabled || previous.current.session !== session;
    previous.current = { enabled, session };
    clearTimeout(idle.current);
    if (!enabled || first) {
      clearTimeout(maximum.current);
      maximum.current = undefined;
    }
    if (!enabled) return;
    const publish = () => {
      clearTimeout(idle.current);
      clearTimeout(maximum.current);
      maximum.current = undefined;
      if (!latest.current.enabled || latest.current.session !== session) return;
      if (latest.current.composing) {
        idle.current = setTimeout(publish, 100);
        return;
      }
      setOutline(extractMarkdownOutline(latest.current.content));
    };
    if (first) publish();
    else {
      idle.current = setTimeout(publish, 100);
      maximum.current ??= setTimeout(publish, 500);
    }
    return () => clearTimeout(idle.current);
  }, [content, enabled, session, composing]);

  useEffect(() => () => {
    clearTimeout(idle.current);
    clearTimeout(maximum.current);
  }, []);
  return outline;
}
