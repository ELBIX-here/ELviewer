import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = (d: React.ReactNode) => (props: P) => (
  <svg viewBox="0 0 24 24" {...props}>
    {d}
  </svg>
);

export const IconBack = base(<path d="M15 18l-6-6 6-6" />);
export const IconMonitor = base(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </>,
);
export const IconPhone = base(
  <>
    <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>,
);
export const IconTablet = base(
  <>
    <rect x="4.5" y="2.5" width="15" height="19" rx="2.5" />
    <path d="M11 18.5h2" />
  </>,
);
export const IconUndo = base(
  <>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </>,
);
export const IconRestart = base(
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3.5 4v4.5H8" />
  </>,
);
export const IconCloud =base(<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.25 9.5z" />);
export const IconList = base(
  <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </>,
);
export const IconSearch = base(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </>,
);
export const IconBookmark = base(<path d="M6 3h12v18l-6-4-6 4z" />);
export const IconBookmarkFilled = (props: P) => (
  <svg viewBox="0 0 24 24" {...props} style={{ fill: "currentColor" }}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
);
export const IconSettings = base(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
);
export const IconScroll = base(
  <>
    <rect x="5" y="3" width="14" height="18" rx="2" />
    <path d="M12 8v8M9 13l3 3 3-3" />
  </>,
);
export const IconPages = base(
  <>
    <path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z" />
    <path d="M20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
  </>,
);
export const IconPrev = base(<path d="M11 18l-6-6 6-6M19 18l-6-6 6-6" />);
export const IconNext = base(<path d="M13 6l6 6-6 6M5 6l6 6-6 6" />);
export const IconFullscreen = base(<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />);
export const IconPlay = base(<path d="M6 4l14 8-14 8z" />);
export const IconPause = base(<path d="M7 4h4v16H7zM13 4h4v16h-4z" />);
export const IconClose = base(<path d="M18 6L6 18M6 6l12 12" />);
export const IconFolderPlus = base(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M12 11v6M9 14h6" />
  </>,
);
export const IconRefresh = base(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </>,
);
export const IconGrid = base(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);
export const IconRows = base(<path d="M4 6h16M4 12h16M4 18h16" />);
export const IconFolder = (props: P) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
export const IconArchive = (props: P) => (
  <svg viewBox="0 0 24 24" {...props}>
    <path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" />
  </svg>
);
export const IconTrash = base(<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />);
export const IconCheck = base(<path d="M5 12l5 5L20 7" />);
export const IconColumns = base(
  <>
    <rect x="3" y="4" width="8" height="16" rx="1.5" />
    <rect x="13" y="4" width="8" height="16" rx="1.5" />
  </>,
);
export const IconChart = base(
  <>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </>,
);
export const IconHeadphones = base(
  <>
    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
    <rect x="3" y="14" width="5" height="7" rx="2" />
    <rect x="16" y="14" width="5" height="7" rx="2" />
  </>,
);
export const IconNote = base(
  <>
    <path d="M4 4h16v12l-4 4H4z" />
    <path d="M16 20v-4h4M8 9h8M8 13h5" />
  </>,
);
export const IconStop = base(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const IconSkipBack = base(<path d="M18 6l-8 6 8 6zM6 6v12" />);
export const IconSkipForward = base(<path d="M6 6l8 6-8 6zM18 6v12" />);
