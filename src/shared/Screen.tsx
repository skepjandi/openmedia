import { useRef, type ReactNode } from "react";
import { useEdgeSwipeBack } from "../features/back/useEdgeSwipeBack";
import { useTrackpadSwipeBack } from "../features/back/useTrackpadSwipeBack";
import { BackIcon, CloseIcon } from "./icons";

interface ScreenProps {
  title: string;
  subtitle?: string;
  closeLabel: string;
  onClose: () => void;
  /** A page opened from another page: the button is a back arrow before the title, not a close cross. */
  back?: boolean;
  children: ReactNode;
}

/**
 * A full-screen page: a large title over a scrolling body, so nothing from the site shows through.
 * The title card is frosted glass pinned to the top; the body scrolls underneath it.
 */
export function Screen({
  title,
  subtitle,
  closeLabel,
  onClose,
  back = false,
  children,
}: ScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  useEdgeSwipeBack(root, onClose);
  useTrackpadSwipeBack(root, onClose);
  const button = (
    <button
      type="button"
      aria-label={closeLabel}
      onClick={onClose}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-paper/[0.08] text-paper/80 active:bg-paper/[0.16]"
    >
      {back ? (
        <span className="rtl:-scale-x-100">
          <BackIcon />
        </span>
      ) : (
        <CloseIcon />
      )}
    </button>
  );
  return (
    <div
      ref={root}
      data-hit=""
      className="screen fixed inset-0 z-50 scroll-pt-[calc(var(--safe-top)+88px)] overflow-y-auto overscroll-contain bg-ink"
    >
      <header className="sticky top-0 z-10 flex items-end gap-4 border-b border-hair bg-ink/60 px-5 pt-[calc(var(--safe-top)+16px)] pb-4 backdrop-blur-xl backdrop-saturate-150">
        {back && button}
        <div className="min-w-0 flex-1">
          <h1 className="text-[2rem] leading-none font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-2 line-clamp-2 text-sm text-paper/55">{subtitle}</p>}
        </div>
        {!back && button}
      </header>
      <div className="px-4 pt-6 pb-[calc(var(--safe-bottom)+96px)]">{children}</div>
    </div>
  );
}
