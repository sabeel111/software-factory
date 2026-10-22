// Small stroke icons (24px grid, 1.8 stroke) so status is never colour alone.
import type { JSX } from "preact";

type P = JSX.SVGAttributes<SVGSVGElement>;
const base = (path: JSX.Element | JSX.Element[], p: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    {...p}
  >
    {path}
  </svg>
);

export const IconCheck = (p: P) => base(<path d="M5 12.5l4.2 4.2L19 7" />, p);
export const IconX = (p: P) => base(<path d="M6 6l12 12M18 6L6 18" />, p);
export const IconPlay = (p: P) => base(<path d="M7 5l12 7-12 7z" fill="currentColor" stroke="none" />, p);
export const IconPause = (p: P) => base([<path d="M8 5v14" />, <path d="M16 5v14" />], p);
export const IconStop = (p: P) => base(<rect x="6" y="6" width="12" height="12" rx="2" />, p);
export const IconFile = (p: P) =>
  base([<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />, <path d="M14 3v5h5" />], p);
export const IconEdit = (p: P) => base([<path d="M4 20h4L19 9l-4-4L4 16z" />, <path d="M13.5 6.5l4 4" />], p);
export const IconPlus = (p: P) => base(<path d="M12 5v14M5 12h14" />, p);
export const IconTerminal = (p: P) => base([<path d="M5 7l5 5-5 5" />, <path d="M13 17h6" />], p);
export const IconSearch = (p: P) => base([<circle cx="11" cy="11" r="6" />, <path d="M20 20l-4.5-4.5" />], p);
export const IconChat = (p: P) =>
  base(<path d="M5 18l-1 3 4-2h9a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v8" />, p);
export const IconMerge = (p: P) =>
  base(
    [
      <circle cx="6" cy="6" r="2" />,
      <circle cx="6" cy="18" r="2" />,
      <circle cx="18" cy="12" r="2" />,
      <path d="M6 8v8M8 6c5 0 8 2 8 6" />,
    ],
    p,
  );
export const IconFlag = (p: P) => base([<path d="M5 21V4" />, <path d="M5 4h11l-2 4 2 4H5" />], p);
export const IconAlert = (p: P) =>
  base([<path d="M12 3l9.5 17h-19z" />, <path d="M12 10v4M12 17.5v.01" />], p);
export const IconInfo = (p: P) => base([<circle cx="12" cy="12" r="9" />, <path d="M12 11v5M12 8v.01" />], p);
export const IconClock = (p: P) => base([<circle cx="12" cy="12" r="9" />, <path d="M12 7v5l3 2" />], p);
export const IconRetry = (p: P) =>
  base(
    [
      <path d="M4 12a8 8 0 0 1 14-5.3L20 9" />,
      <path d="M20 4v5h-5" />,
      <path d="M20 12a8 8 0 0 1-14 5.3L4 15" />,
    ],
    p,
  );
export const IconLink = (p: P) =>
  base(
    [
      <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" />,
      <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" />,
    ],
    p,
  );
export const IconSun = (p: P) =>
  base(
    [
      <circle cx="12" cy="12" r="4" />,
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
    ],
    p,
  );
export const IconMoon = (p: P) => base(<path d="M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z" />, p);
export const IconBeaker = (p: P) =>
  base(
    [
      <path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" />,
      <path d="M7 15h10" />,
    ],
    p,
  );
export const IconSpark = (p: P) =>
  base(<path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" />, p);
export const IconGear = (p: P) =>
  base(
    [
      <circle cx="12" cy="12" r="3" />,
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />,
    ],
    p,
  );
export const IconHistory = (p: P) =>
  base([<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />, <path d="M3 3v5h5" />, <path d="M12 7v5l3 2" />], p);
export const IconPulse = (p: P) => base(<path d="M3 12h4l2-6 4 12 2-6h6" />, p);

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M7 23V13l6 4v-4l6 4V9h6v14z" fill="#fff" />
    </svg>
  );
}

export function toolIcon(tool?: string, kind?: string) {
  if (kind === "text") return <IconChat />;
  if (kind === "result") return <IconAlert />;
  switch (tool) {
    case "Read":
      return <IconFile />;
    case "Edit":
    case "MultiEdit":
      return <IconEdit />;
    case "Write":
      return <IconPlus />;
    case "Bash":
      return <IconTerminal />;
    case "Grep":
    case "Glob":
      return <IconSearch />;
    default:
      return <IconSpark />;
  }
}
