import { useEffect, useRef, type ReactNode } from "react";
import { useApp } from "../app/store";
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
  /** Desktop only: a column beside the page, such as a list of its parts. Phones show it above the body. */
  sidebar?: ReactNode;
  /** A page that swaps its content in place: when this changes, the body scrolls back to the top. */
  pageKey?: string;
  children: ReactNode;
}

/**
 * A full-screen page: a title over a scrolling body, so nothing from the site shows through.
 * The title card is frosted glass pinned to the top; the body scrolls underneath it. On a phone
 * the title is large and the body fills the width; on desktop the title bar is compact, carries
 * the key that closes the page, and the body is a centered column that may have a sidebar.
 */
export function Screen({
  title,
  subtitle,
  closeLabel,
  onClose,
  back = false,
  sidebar,
  pageKey,
  children,
}: ScreenProps) {
  const root = useRef<HTMLDivElement>(null);
  const desktop = useApp((s) => s.desktop);
  useEffect(() => {
    root.current?.scrollTo(0, 0);
  }, [pageKey]);
  useEdgeSwipeBack(root, onClose);
  useTrackpadSwipeBack(root, onClose);
  const button = (
    <button
      type="button"
      aria-label={closeLabel}
      onClick={onClose}
      className="grid size-10 shrink-0 place-items-center rounded-full bg-paper/[0.08] text-paper/80 hover:bg-paper/[0.14] active:bg-paper/[0.16] desktop:size-9 desktop:rounded-lg"
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

  if (desktop) {
    return (
      <div
        ref={root}
        data-hit=""
        className="screen fixed inset-0 z-50 scroll-pt-20 overflow-y-auto overscroll-contain bg-ink"
      >
        <header className="sticky top-0 z-10 border-b border-hair bg-ink/70 backdrop-blur-xl backdrop-saturate-150">
          <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-8">
            {back && button}
            <h1 className="shrink-0 text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && (
              <p className="min-w-0 flex-1 truncate ps-2 text-sm text-paper/50">{subtitle}</p>
            )}
            {!subtitle && <span className="flex-1" />}
            <kbd className="keycap shrink-0" aria-hidden="true">
              Esc
            </kbd>
            {!back && button}
          </div>
        </header>
        <div
          className={`mx-auto w-full max-w-6xl px-8 py-8 pb-24 ${
            sidebar ? "grid grid-cols-[14rem_minmax(0,1fr)] items-start gap-12" : ""
          }`}
        >
          {sidebar && <aside className="sticky top-24 self-start">{sidebar}</aside>}
          <div className={sidebar ? "min-w-0 max-w-3xl" : "mx-auto max-w-3xl"}>{children}</div>
        </div>
      </div>
    );
  }

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
      <div className="px-4 pt-6 pb-[calc(var(--safe-bottom)+96px)]">
        {sidebar && <div className="mb-6">{sidebar}</div>}
        {children}
      </div>
    </div>
  );
}
