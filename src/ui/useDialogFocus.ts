import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep confirmation dialogs keyboard-modal, then return to the interrupted edit. */
export function useDialogFocus(ref: RefObject<HTMLDivElement | null>, key: string | null, restoreEditor: () => void) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const restore = useRef(restoreEditor);
  restore.current = restoreEditor;
  useLayoutEffect(() => {
    if (!key) {
      const previous = previousFocus.current;
      previousFocus.current = null;
      if (previous) {
        if (previous.isConnected && (previous.matches('input, textarea') || previous.isContentEditable)) {
          previous.focus({ preventScroll: true });
        } else restore.current();
      }
      return;
    }
    const dialog = ref.current;
    if (!dialog) return;
    previousFocus.current ??= document.activeElement as HTMLElement;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]'
    ));
    const focusFirst = () => (controls()[0] ?? dialog).focus({ preventScroll: true });
    focusFirst();
    const keepFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusFirst();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls();
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === items.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? items.at(-1) ?? dialog : items[0] ?? dialog).focus({ preventScroll: true });
      }
    };
    document.addEventListener('focusin', keepFocus);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', keepFocus);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [key, ref]);
}
