import { quickAccess } from "../../shared/favorites";
import { hubForFavorite } from "../../shared/hubs";
import type { SiteSettings, SiteViewState } from "../../shared/ipc";

/** Where a session came from: tapped from favorites, typed or picked from history, restored, or opened as a hub page. */
export type SessionSource = "favorite" | "typed" | "restored" | "hub";

export interface Session {
  id: string;
  source: SessionSource;
  /** The hub recipe a hub session was opened from; null for every other session. */
  hubId: string | null;
  /** The address the session was opened with. */
  openedUrl: string;
  /** The registrable domain the native side pinned the session to; unknown until it loads. */
  scope: string | null;
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Pages from before a restart, oldest first: Back opens them once the page has no history of its own. */
  restoredBack: string[];
  /** The page has drawn its first content and is showing. */
  painted: boolean;
  /** When the session was last visible or opened, in ms. */
  lastUsed: number;
  /** When the session was opened, in ms. */
  openedAt: number;
  /** Milliseconds from opening to the first drawn content; null until it has painted. */
  paintMs: number | null;
  /** When the load now in flight began, in ms; null while no load is running. */
  loadStartedAt: number | null;
  /** How long the last finished load took, in ms. Sampled from state events, so it is approximate. */
  loadMs: number | null;
}

/** Usual total session budget; expands only for quick-access pages plus the visible page. */
export const MAX_SESSIONS = 5;
/** Unprotected hidden pages idle longer than this are closed. */
export const IDLE_LIMIT_MS = 20 * 60_000;

export function newSession(
  id: string,
  source: SessionSource,
  url: string,
  now: number,
  hubId: string | null = null,
  restoredBack: string[] = [],
): Session {
  return {
    id,
    source,
    hubId,
    openedUrl: url,
    scope: null,
    url: null,
    title: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    restoredBack,
    painted: false,
    lastUsed: now,
    openedAt: now,
    paintMs: null,
    loadStartedAt: now,
    loadMs: null,
  };
}

/** The measurements a state event adds: first paint once, and the duration of each load. */
function measure(session: Session, state: SiteViewState, now: number) {
  const paintMs =
    session.paintMs === null && state.painted ? now - session.openedAt : session.paintMs;
  if (state.loading && !session.loading)
    return { paintMs, loadStartedAt: now, loadMs: session.loadMs };
  if (!state.loading && session.loading && session.loadStartedAt !== null)
    return { paintMs, loadStartedAt: null, loadMs: now - session.loadStartedAt };
  return { paintMs, loadStartedAt: session.loadStartedAt, loadMs: session.loadMs };
}

export function applyState(session: Session, state: SiteViewState, now = Date.now()): Session {
  return {
    ...session,
    ...measure(session, state, now),
    scope: state.scope,
    url: state.url,
    title: state.title,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    painted: state.painted,
  };
}

/** Whether Back has somewhere to go: the page's own history, else the pages saved before a restart. */
export function canStepBack(session: Session | null): boolean {
  return session !== null && (session.canGoBack || session.restoredBack.length > 0);
}

/**
 * The trail of pages behind a page that finished loading `url`, after it came from `previous`.
 * Moving to the page just behind goes back; any other address moves forward.
 */
export function advanceTrail(trail: readonly string[], previous: string | null, url: string) {
  if (previous === null || previous === url) return trail;
  if (trail[trail.length - 1] === url) return trail.slice(0, -1);
  return [...trail, previous].slice(-MAX_TRAIL);
}

const MAX_TRAIL = 20;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for the scope itself and its subdomains, never for a lookalike such as `notx.com`. */
export function scopeCovers(scope: string, url: string): boolean {
  const host = hostOf(url);
  return host !== null && (host === scope || host.endsWith(`.${scope}`));
}

const GENERIC_HOST_PREFIX = /^(www|m|mobile)\./;

/** The host without a generic prefix, so `www.` and `m.` are the same place but `music.` is not. */
function placeOf(url: string): string | null {
  const host = hostOf(url);
  return host === null ? null : host.replace(GENERIC_HOST_PREFIX, "");
}

/** True when the session was opened on, or is showing, the same place as `url`. */
function onSamePlace(session: Session, url: string): boolean {
  const place = placeOf(url);
  return (
    place !== null &&
    (placeOf(session.openedUrl) === place ||
      (session.url !== null && placeOf(session.url) === place))
  );
}

/**
 * The live session a favorite should switch to instead of opening again: one on the favorite's
 * site, preferring sessions that came from a favorite and then the most recently used. Sites that
 * share a domain but live on their own subdomain (`music.` against `www.`) are not the same
 * favorite; only `www.`/`m.` variants are. A session whose domain is not known yet matches only
 * the exact address it was opened with. Hub pages are sessions of their own: a favorite never
 * switches to one (Instagram must not open the Messages Hub's inbox), and a page of a hub
 * (`hubId`) switches only to a session of that same hub.
 */
export function findFavoriteSession(
  sessions: Session[],
  favoriteUrl: string,
  hubId: string | null = null,
): Session | undefined {
  return sessions
    .filter((s) => s.hubId === hubId)
    .filter((s) =>
      s.scope
        ? scopeCovers(s.scope, favoriteUrl) && onSamePlace(s, favoriteUrl)
        : s.openedUrl === favoriteUrl,
    )
    .sort(
      (a, b) =>
        Number(b.source === "favorite") - Number(a.source === "favorite") ||
        b.lastUsed - a.lastUsed,
    )[0];
}

/**
 * The live session of a quick-access favorite. A favorite that stands for a hub (see
 * `hubForFavorite`) belongs to that hub's session, so it is retained and badged like any other.
 */
export function sessionForFavorite(
  sessions: Session[],
  favoriteUrl: string,
  sites: readonly SiteSettings[],
): Session | undefined {
  return findFavoriteSession(
    sessions,
    favoriteUrl,
    hubForFavorite(sites, favoriteUrl)?.recipeId ?? null,
  );
}

/**
 * The page the app opens with. One on a favorite's site counts as a favorite session, so the
 * session cap spares it like any other favorite.
 */
export function startSource(favorites: { url: string }[], url: string): SessionSource {
  const host = hostOf(url);
  return host !== null && favorites.some((favorite) => hostOf(favorite.url) === host)
    ? "favorite"
    : "restored";
}

/** The live typed session opened with exactly this address, so a history tap does not reload. */
export function findTypedSession(sessions: Session[], url: string): Session | undefined {
  return sessions
    .filter((s) => s.source === "typed" && s.openedUrl === url)
    .sort((a, b) => b.lastUsed - a.lastUsed)[0];
}

export type Pressure = "routine" | "memory";

/**
 * Which hidden sessions to close. The visible one is never listed.
 *
 * - `memory`: the OS asked for memory back, so every hidden session goes.
 * - `routine`: keep the session each quick-access favorite would activate. Other hidden pages
 *   expire after `IDLE_LIMIT_MS`, then the oldest non-favorites go first to meet the usual cap.
 *   The cap grows only enough for the retained sessions plus the visible page.
 */
export function sessionsToClose(
  sessions: Session[],
  activeId: string | null,
  now: number,
  pressure: Pressure,
  favorites: readonly { url: string }[],
  sites: readonly SiteSettings[] = [],
): string[] {
  const hidden = sessions.filter((s) => s.id !== activeId);
  if (pressure === "memory") return hidden.map((s) => s.id);

  const retained = new Set<string>();
  for (const { url } of quickAccess(favorites)) {
    const session = sessionForFavorite(sessions, url, sites);
    if (session) retained.add(session.id);
  }
  const unprotected = hidden.filter((s) => !retained.has(s.id));
  const idle = unprotected.filter((s) => now - s.lastUsed > IDLE_LIMIT_MS);
  const survivors = unprotected
    .filter((s) => !idle.includes(s))
    .sort(
      (a, b) =>
        Number(a.source === "favorite") - Number(b.source === "favorite") ||
        a.lastUsed - b.lastUsed,
    );
  const required = retained.size + Number(activeId !== null && !retained.has(activeId));
  const limit = Math.max(MAX_SESSIONS, required);
  const excess = Math.max(0, sessions.length - idle.length - limit);
  return [...idle, ...survivors.slice(0, excess)].map((s) => s.id);
}
