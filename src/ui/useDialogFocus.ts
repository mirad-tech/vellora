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
        if (previous.isConnected && !previous.matches(':disabled') && !previous.closest('[inert]') &&
          (previous.matches('input, textarea') || previous.isContentEditable)) {
          previous.focus({ preventScroll: true });
          if (document.activeElement === previous) return;
        }
        restore.current();
      }
      return;
    }
    const dialog = ref.current;
    if (!dialog) return;
    previousFocus.current ??= document.activeElement as HTMLElement;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]'
    )).filter(element => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
    const focusInitial = () => {
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]:not(:disabled)');
      (initial ?? dialog).focus({ preventScroll: true });
    };
    focusInitial();
    const keepFocus = (event: FocusEvent) => {
      if (!dialog.contains(event.target as Node)) focusInitial();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.isComposing || event.keyCode === 229) return;
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
