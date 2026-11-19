import { quickAccess } from "../../shared/favorites";
import type { Favorite } from "../../shared/ipc";
import { unreadCount } from "../../shared/unread";
import type { SiteSettings } from "../../shared/ipc";
import { sessionForFavorite, type Session } from "./sessions";

/** A page can rewrite its own title at will, so one session may raise a notification this often. */
export const NOTIFY_MIN_GAP_MS = 30_000;

export interface Watch {
  /** The unread count the page last announced. */
  count: number;
  /** When a notification last went out for this session, in ms; `-Infinity` if none has. */
  notifiedAt: number;
}

export interface Observation {
  watch: Watch;
  notify: boolean;
}

/**
 * Folds one title into a session's watch. A notification is due only when the page's count rises
 * past what was last seen while the user is looking elsewhere, and not twice within
 * `NOTIFY_MIN_GAP_MS`. The first title seen is a baseline, so a page that loads already showing
 * `(3)` does not announce what the user could already see; a missing title changes nothing.
 */
export function observeTitle(
  previous: Watch | undefined,
  title: string | null,
  hidden: boolean,
  now: number,
): Observation {
  if (title === null) {
    return { watch: previous ?? { count: 0, notifiedAt: -Infinity }, notify: false };
  }
  const count = unreadCount(title);
  if (!previous) return { watch: { count, notifiedAt: -Infinity }, notify: false };
  const due = hidden && count > previous.count && now - previous.notifiedAt >= NOTIFY_MIN_GAP_MS;
  return {
    watch: { count, notifiedAt: due ? now : previous.notifiedAt },
    notify: due,
  };
}

/** The quick-access favorite whose live session is `sessionId`, if any. */
export function quickFavoriteOf(
  sessions: Session[],
  favorites: readonly Favorite[],
  sessionId: string,
  sites: readonly SiteSettings[] = [],
): Favorite | undefined {
  return quickAccess(favorites).find(
    (favorite) => sessionForFavorite(sessions, favorite.url, sites)?.id === sessionId,
  );
}

/**
 * The unread count to badge on each quick-access favorite, in menu order. The page on screen is
 * never badged: the user is already looking at it.
 */
export function unreadByFavorite(
  sessions: Session[],
  favorites: readonly Favorite[],
  activeId: string | null,
  sites: readonly SiteSettings[] = [],
): number[] {
  return quickAccess(favorites).map((favorite) => {
    const session = sessionForFavorite(sessions, favorite.url, sites);
    return session && session.id !== activeId ? unreadCount(session.title) : 0;
  });
}

/** Whether each quick-access favorite's live session is playing sound or video, in menu order. */
export function playingByFavorite(
  sessions: Session[],
  favorites: readonly Favorite[],
  sites: readonly SiteSettings[] = [],
): boolean[] {
  return quickAccess(favorites).map(
    (favorite) => sessionForFavorite(sessions, favorite.url, sites)?.playing === true,
  );
}
