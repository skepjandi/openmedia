import type { ReactNode } from "react";

function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const BackIcon = () => (
  <Icon>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const ChevronLeftIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const ChevronRightIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const ForwardIcon = () => (
  <Icon>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const ReloadIcon = () => (
  <Icon>
    <path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const FilterIcon = () => (
  <Icon>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Icon>
);

export const ArrowIcon = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const UpIcon = () => (
  <Icon>
    <path d="M6 14l6-6 6 6" />
  </Icon>
);

export const DownIcon = () => (
  <Icon>
    <path d="M6 10l6 6 6-6" />
  </Icon>
);

export const SlidersIcon = () => (
  <Icon>
    <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="17" cy="17" r="2" />
  </Icon>
);

export const HistoryIcon = () => (
  <Icon>
    <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5" />
    <path d="M12 8v4.5l3 1.8" />
  </Icon>
);

export const ChatsIcon = () => (
  <Icon>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
    <path d="M8 10h8M8 13h5" />
  </Icon>
);

export const TabsIcon = () => (
  <Icon>
    <rect x="3.5" y="8" width="13" height="11" rx="2.2" />
    <path d="M7.5 8V6.2A2.2 2.2 0 0 1 9.7 4h8.1A2.2 2.2 0 0 1 20 6.2v7.1a2.2 2.2 0 0 1-2.2 2.2H16.5" />
  </Icon>
);

export const StarIcon = ({ filled = false }: { filled?: boolean }) => (
  <Icon>
    <path
      d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z"
      fill={filled ? "currentColor" : "none"}
    />
  </Icon>
);

export const StatsIcon = () => (
  <Icon>
    <path d="M5 20V12M12 20V5M19 20v-5" />
  </Icon>
);

/** A hat and glasses. Active fills the lenses, so the on state reads without color. */
export const IncognitoIcon = ({ active = false, size }: { active?: boolean; size?: number }) => (
  <Icon size={size}>
    <path d="M3 11h18M6 11l1.6-5.3a1 1 0 0 1 1-.7h6.8a1 1 0 0 1 1 .7L18 11" />
    <circle cx="8" cy="16.5" r="2.5" fill={active ? "currentColor" : "none"} />
    <circle cx="16" cy="16.5" r="2.5" fill={active ? "currentColor" : "none"} />
    <path d="M10.5 16.5h3" />
  </Icon>
);

/** A play button over a seek bar. Off draws a slash through it, so the state reads without color. */
export const VideoControlsIcon = ({ on = true }: { on?: boolean }) => (
  <Icon>
    <path d="M9 4.5v9l7-4.5-7-4.5z" fill={on ? "currentColor" : "none"} />
    <path d="M4 18.5h16" />
    {!on && <path d="M4 4l16 16" />}
  </Icon>
);

/** Dark mode: a crescent moon, filled while dark mode is on. */
export const MoonIcon = ({ on = true }: { on?: boolean }) => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill={on ? "currentColor" : "none"} />
  </Icon>
);

/** Color picker: an eyedropper. */
export const ColorPickerIcon = () => (
  <Icon>
    <path d="M14.5 5.5l4 4" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4L16.5 3.5z" />
  </Icon>
);

/** Downloads: an arrow into a tray. */
export const DownloadIcon = () => (
  <Icon>
    <path d="M12 4v11" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M5 19h14" />
  </Icon>
);

/** Technology detector: code brackets over a magnifier-free page outline. */
export const TechIcon = () => (
  <Icon>
    <path d="M8 7l-5 5 5 5" />
    <path d="M16 7l5 5-5 5" />
    <path d="M13.5 5l-3 14" />
  </Icon>
);

/** Pro: a crown. Marks what the paywall unlocks. */
export const ProIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 7l4.5 4.5L12 5l4.5 6.5L21 7l-1.5 11h-15L3 7z" />
  </Icon>
);

/** Face ID: the corner brackets, eyes, nose and smile of Apple's glyph. */
export const FaceIdIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M8 3H6a3 3 0 0 0-3 3v2" />
    <path d="M16 3h2a3 3 0 0 1 3 3v2" />
    <path d="M8 21H6a3 3 0 0 1-3-3v-2" />
    <path d="M16 21h2a3 3 0 0 0 3-3v-2" />
    <path d="M9 9.5v1.5" />
    <path d="M15 9.5v1.5" />
    <path d="M12 9.5v3.5h-1" />
    <path d="M9 16c.8.9 1.8 1.4 3 1.4s2.2-.5 3-1.4" />
  </Icon>
);

/** Touch ID or another fingerprint check. */
export const FingerprintIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
    <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
    <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
    <path d="M2 12a10 10 0 0 1 18-6" />
    <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
    <path d="M8.65 22c.21-.66.45-1.32.57-2" />
    <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    <path d="M21.8 16c.2-2 .131-5.354 0-6" />
  </Icon>
);
