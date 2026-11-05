import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function restoreFocus(previous: HTMLElement | null, fallback: HTMLElement | null) {
  if (previous?.isConnected && previous !== document.body && !previous.matches(':disabled')) {
    previous.focus({ preventScroll: true });
    // A committed quick-edit block can stay connected after losing contenteditable.
    if (document.activeElement === previous) return;
  }
  fallback?.focus({ preventScroll: true });
}

/** Keep a confirmation's keyboard interaction inside its visible surface. */
export function useDialogFocus(
  open: boolean,
  dialogRef: RefObject<HTMLDivElement | null>,
  fallbackRef: RefObject<HTMLButtonElement | null>
) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const getFocusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => !element.closest('[hidden], [inert], [aria-hidden="true"]'));
    // Close confirmations have destructive actions: focus the dialog itself first.
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]') ?? dialog;
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.isComposing) return;
      const items = getFocusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        (initial.isConnected && !initial.matches(':disabled') ? initial : dialog)
          .focus({ preventScroll: true });
      }
    };

    dialog.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      restoreFocus(previous, fallbackRef.current);
    };
  }, [open, dialogRef, fallbackRef]);
}
