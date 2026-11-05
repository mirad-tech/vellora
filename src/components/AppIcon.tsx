import type { ReactNode } from 'react';

type IconName = 'folder' | 'save' | 'search' | 'outline' | 'close' | 'up' | 'down' | 'loading' | 'alert';

const paths: Record<IconName, ReactNode> = {
  folder: <path d="M2 5.5V4.25A1.25 1.25 0 0 1 3.25 3h3L7.5 4.5h5.25A1.25 1.25 0 0 1 14 5.75V7M2 6.5h11.75a.75.75 0 0 1 .72.96l-1.35 4.5a1.5 1.5 0 0 1-1.44 1.04H3.25A1.25 1.25 0 0 1 2 11.75Z" />,
  save: <><path d="M11.25 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5V4.75Z" /><path d="M5 2v4h6V2M5 14V9h6v5" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></>,
  outline: <><path d="M6 4h8M6 8h8M6 12h8M2 4h.5M2 8h.5M2 12h.5" /></>,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  up: <path d="m4 7 4-4 4 4M8 3v10" />,
  down: <path d="m4 9 4 4 4-4M8 13V3" />,
  loading: <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" />,
  alert: <><circle cx="8" cy="8" r="5.75" /><path d="M8 4.75v3.5M8 11h.01" /></>
};

export function AppIcon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`app-icon ${className}`.trim()}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
