import { describe, expect, it } from "vitest";
import type { SiteSettings, SiteViewState } from "../../shared/ipc";
import {
  IDLE_LIMIT_MS,
  MAX_SESSIONS,
  applyState,
  findFavoriteSession,
  findTypedSession,
  newSession,
  scopeCovers,
  sessionForFavorite,
  sessionsToClose,
  startSource,
  type Session,
  type SessionSource,
} from "./sessions";

const NOW = 10_000_000;

function session(id: string, source: SessionSource, overrides: Partial<Session> = {}): Session {
  const openedUrl = overrides.scope ? `https://${overrides.scope}/` : `https://${id}.example/`;
  return { ...newSession(id, source, openedUrl, NOW), ...overrides };
}

describe("scopeCovers", () => {
  it("covers the domain and its subdomains", () => {
    expect(scopeCovers("instagram.com", "https://www.instagram.com/reels")).toBe(true);
    expect(scopeCovers("instagram.com", "https://instagram.com/")).toBe(true);
  });

  it("rejects lookalikes and unrelated hosts", () => {
    expect(scopeCovers("instagram.com", "https://notinstagram.com/")).toBe(false);
    expect(scopeCovers("instagram.com", "https://instagram.com.evil.io/")).toBe(false);
    expect(scopeCovers("instagram.com", "not a url")).toBe(false);
  });
});

describe("findFavoriteSession", () => {
  it("finds a live session on the favorite's site, whatever subdomain it is on", () => {
    const live = session("a", "typed", { scope: "youtube.com" });
    expect(findFavoriteSession([live], "https://m.youtube.com/")).toBe(live);
  });

  it("prefers a favorite session, then the most recently used", () => {
    const typed = session("a", "typed", { scope: "youtube.com", lastUsed: NOW });
    const older = session("b", "favorite", { scope: "youtube.com", lastUsed: NOW - 5 });
    const newer = session("c", "favorite", { scope: "youtube.com", lastUsed: NOW - 1 });
    expect(findFavoriteSession([typed, older, newer], "https://m.youtube.com/")).toBe(newer);
  });

  it("matches a session whose domain is still unknown only by its exact address", () => {
    const loading = session("a", "favorite", { openedUrl: "https://m.youtube.com/" });
    expect(findFavoriteSession([loading], "https://m.youtube.com/")).toBe(loading);
    expect(findFavoriteSession([loading], "https://www.reddit.com/")).toBeUndefined();
  });

  it("does not match another site", () => {
    const other = session("a", "favorite", { scope: "reddit.com" });
    expect(findFavoriteSession([other], "https://m.youtube.com/")).toBeUndefined();
  });

  it("keeps sites on their own subdomain apart from the main site", () => {
    const main = session("a", "favorite", {
      scope: "youtube.com",
      openedUrl: "https://www.youtube.com/",
      url: "https://www.youtube.com/watch?v=1",
    });
    const music = session("b", "favorite", {
      scope: "youtube.com",
      openedUrl: "https://music.youtube.com/",
    });
    expect(findFavoriteSession([main], "https://music.youtube.com/")).toBeUndefined();
    expect(findFavoriteSession([music], "https://www.youtube.com/")).toBeUndefined();
    expect(findFavoriteSession([main, music], "https://music.youtube.com/")).toBe(music);
    expect(findFavoriteSession([main, music], "https://m.youtube.com/")).toBe(main);
  });

  it("keeps a hub page and a favorite on the same site apart", () => {
    const inbox = session("inbox", "hub", { scope: "instagram.com", hubId: "messages" });
    const feed = session("feed", "favorite", { scope: "instagram.com" });
    expect(findFavoriteSession([inbox], "https://www.instagram.com/")).toBeUndefined();
    expect(findFavoriteSession([inbox, feed], "https://www.instagram.com/")).toBe(feed);
    expect(
      findFavoriteSession([inbox, feed], "https://www.instagram.com/direct/", "messages"),
    ).toBe(inbox);
    expect(
      findFavoriteSession([feed], "https://www.instagram.com/direct/", "messages"),
    ).toBeUndefined();
  });

  it("keeps the pages of two hubs on the same site apart", () => {
    const first = session("a", "hub", { scope: "instagram.com", hubId: "first" });
    const second = session("b", "hub", { scope: "instagram.com", hubId: "second" });
    expect(findFavoriteSession([first, second], "https://www.instagram.com/", "second")).toBe(
      second,
    );
  });
});

describe("findTypedSession", () => {
  it("matches typed sessions opened with exactly that address", () => {
    const typed = session("a", "typed", { openedUrl: "https://a.example/" });
    const favorite = session("b", "favorite", { openedUrl: "https://a.example/" });
    expect(findTypedSession([favorite, typed], "https://a.example/")).toBe(typed);
    expect(findTypedSession([favorite], "https://a.example/")).toBeUndefined();
  });
});

describe("sessionsToClose", () => {
  const many = (count: number, source: SessionSource = "typed") =>
    Array.from({ length: count }, (_, i) => session(`s${i}`, source, { lastUsed: NOW - i }));

  it("keeps everything while under the cap and fresh", () => {
    expect(sessionsToClose(many(MAX_SESSIONS), "s0", NOW, "routine", [])).toEqual([]);
  });

  it("closes hidden sessions idle past the limit, never the visible one", () => {
    const stale = NOW - IDLE_LIMIT_MS - 1;
    const sessions = [
      session("visible", "typed", { lastUsed: stale }),
      session("old", "favorite", { lastUsed: stale }),
      session("fresh", "typed"),
    ];
    expect(sessionsToClose(sessions, "visible", NOW, "routine", [])).toEqual(["old"]);
  });

  it("closes the oldest typed sessions first when over the cap, sparing favorites", () => {
    const sessions = [
      session("fav-old", "favorite", { lastUsed: NOW - 100 }),
      session("typed-old", "typed", { lastUsed: NOW - 50 }),
      session("typed-new", "typed", { lastUsed: NOW - 10 }),
      session("fav-new", "favorite", { lastUsed: NOW - 5 }),
      session("visible", "typed", { lastUsed: NOW }),
      session("typed-mid", "typed", { lastUsed: NOW - 30 }),
    ];
    expect(sessionsToClose(sessions, "visible", NOW, "routine", [])).toEqual(["typed-old"]);
    const more = [...sessions, session("extra", "typed", { lastUsed: NOW - 1 })];
    expect(sessionsToClose(more, "visible", NOW, "routine", [])).toEqual([
      "typed-old",
      "typed-mid",
    ]);
  });

  it("does not double count sessions that are already idle against the cap", () => {
    const stale = NOW - IDLE_LIMIT_MS - 1;
    const sessions = [
      ...many(MAX_SESSIONS),
      session("idle-a", "typed", { lastUsed: stale }),
      session("idle-b", "typed", { lastUsed: stale }),
    ];
    expect(sessionsToClose(sessions, "s0", NOW, "routine", []).sort()).toEqual([
      "idle-a",
      "idle-b",
    ]);
  });

  it("keeps all five quick-access pages past the idle limit alongside a typed page", () => {
    const favorites = many(5, "favorite").map((page) => ({
      ...page,
      lastUsed: NOW - IDLE_LIMIT_MS - 1,
    }));
    const sessions = [...favorites, session("visible", "typed")];
    const urls = favorites.map((page) => ({ url: page.openedUrl }));
    expect(sessionsToClose(sessions, "visible", NOW, "routine", urls)).toEqual([]);
  });

  it("bounds extra browsing without evicting the five quick-access pages", () => {
    const favorites = many(5, "favorite");
    const sessions = [
      ...favorites,
      session("older", "typed", { lastUsed: NOW - 100 }),
      session("newer", "restored", { lastUsed: NOW - 50 }),
      session("visible", "typed"),
    ];
    const urls = favorites.map((page) => ({ url: page.openedUrl }));
    expect(sessionsToClose(sessions, "visible", NOW, "routine", urls)).toEqual(["older", "newer"]);
  });

  it("does not expand the budget for duplicate or unopened favorites", () => {
    const sessions = [
      session("chosen", "typed", { scope: "video.example", lastUsed: NOW - 100 }),
      ...many(6),
      session("visible", "typed"),
    ];
    const favorites = [
      { url: "https://video.example/" },
      { url: "https://m.video.example/" },
      { url: "https://unopened1.example/" },
      { url: "https://unopened2.example/" },
      { url: "https://unopened3.example/" },
      { url: "https://unopened4.example/" },
    ];
    expect(sessionsToClose(sessions, "visible", NOW, "routine", favorites)).toEqual([
      "s5",
      "s4",
      "s3",
    ]);
  });

  it("retains reusable typed and restored pages but not a lookalike domain", () => {
    const stale = NOW - IDLE_LIMIT_MS - 1;
    const sessions = [
      session("typed", "typed", { scope: "video.example", lastUsed: stale }),
      session("restored", "restored", { scope: "social.example", lastUsed: stale }),
      session("lookalike", "favorite", { scope: "notvideo.example", lastUsed: stale }),
      session("visible", "typed"),
    ];
    const favorites = [{ url: "https://m.video.example/" }, { url: "https://social.example/" }];
    expect(sessionsToClose(sessions, "visible", NOW, "routine", favorites)).toEqual(["lookalike"]);
  });

  it("retains only the favorite-tap target when quick-access entries share a site", () => {
    const stale = NOW - IDLE_LIMIT_MS - 1;
    const sessions = [
      session("typed", "typed", { scope: "video.example", lastUsed: stale }),
      session("older", "favorite", { scope: "video.example", lastUsed: stale - 10 }),
      session("chosen", "favorite", { scope: "video.example", lastUsed: stale }),
      session("visible", "typed"),
    ];
    const favorites = [{ url: "https://m.video.example/" }, { url: "https://www.video.example/" }];
    expect(sessionsToClose(sessions, "visible", NOW, "routine", favorites)).toEqual([
      "typed",
      "older",
    ]);
  });

  it("follows the current first five when favorites are reordered or removed", () => {
    const favorites = many(6, "favorite").map((page) => ({
      ...page,
      lastUsed: NOW - IDLE_LIMIT_MS - 1,
    }));
    const sessions = [...favorites, session("visible", "typed")];
    const urls = favorites.map((page) => ({ url: page.openedUrl }));
    expect(sessionsToClose(sessions, "visible", NOW, "routine", urls)).toEqual(["s5"]);
    expect(sessionsToClose(sessions, "visible", NOW, "routine", urls.slice(1))).toEqual(["s0"]);
    expect(sessionsToClose(sessions, "visible", NOW, "routine", [])).toEqual(
      favorites.map((page) => page.id),
    );
  });

  it("closes every hidden session on a memory warning and keeps the visible one", () => {
    const favorites = many(6, "favorite");
    const sessions = [...favorites, session("visible", "typed")];
    const urls = favorites.map((page) => ({ url: page.openedUrl }));
    expect(sessionsToClose(sessions, "visible", NOW, "memory", urls)).toEqual(
      favorites.map((page) => page.id),
    );
  });

  it("closes nothing visible when nothing is active", () => {
    expect(sessionsToClose(many(2), null, NOW, "memory", [])).toEqual(["s0", "s1"]);
  });
});

describe("applyState", () => {
  it("copies what the page reported and keeps the session's own identity", () => {
    const base = session("a", "favorite");
    const next = applyState(base, {
      session: "a",
      url: "https://x.com/home",
      title: "Home",
      loading: false,
      canGoBack: true,
      canGoForward: false,
      painted: true,
      scope: "x.com",
    });
    expect(next).toMatchObject({
      id: "a",
      source: "favorite",
      openedUrl: base.openedUrl,
      scope: "x.com",
      url: "https://x.com/home",
      loading: false,
      canGoBack: true,
    });
  });
});

describe("startSource", () => {
  const favorites = [{ url: "https://www.instagram.com/" }, { url: "https://m.youtube.com/" }];

  it("counts a startup page on a favorite's site as a favorite session", () => {
    expect(startSource(favorites, "https://www.instagram.com/")).toBe("favorite");
    expect(startSource(favorites, "https://m.youtube.com/watch?v=1")).toBe("favorite");
  });

  it("restores any other page as a plain restored session", () => {
    expect(startSource(favorites, "https://example.com/")).toBe("restored");
    expect(startSource([], "https://www.instagram.com/")).toBe("restored");
  });
});

describe("a hub's quick-access favorite", () => {
  const sites: SiteSettings[] = [
    {
      recipeId: "messages",
      name: "Messages Hub",
      homepage: "https://web.whatsapp.com/",
      favorite: true,
      options: [],
      bottomMargin: null,
      origin: "user",
      author: null,
      hub: { tabs: [{ label: "WhatsApp", url: "https://web.whatsapp.com/" }] },
    },
  ];
  const inbox = () =>
    session("inbox", "hub", {
      scope: "whatsapp.com",
      openedUrl: "https://web.whatsapp.com/",
      hubId: "messages",
    });
  const favorites = [{ url: "https://web.whatsapp.com/" }];

  it("finds the hub session, not a plain page of the same site", () => {
    const plain = session("plain", "favorite", { scope: "whatsapp.com" });
    expect(sessionForFavorite([plain, inbox()], favorites[0].url, sites)?.id).toBe("inbox");
  });

  it("keeps the hub session from the idle sweep", () => {
    const idle = { ...inbox(), lastUsed: NOW - IDLE_LIMIT_MS - 1 };
    expect(sessionsToClose([idle, session("v", "typed")], "v", NOW, "routine", favorites)).toEqual([
      "inbox",
    ]);
    expect(
      sessionsToClose([idle, session("v", "typed")], "v", NOW, "routine", favorites, sites),
    ).toEqual([]);
  });
});

describe("applyState measurements", () => {
  const state = (overrides: Partial<SiteViewState>): SiteViewState => ({
    session: "a",
    url: "https://a.example/",
    title: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    painted: false,
    scope: "a.example",
    ...overrides,
  });

  it("records first paint once, from when the session opened", () => {
    const opened = newSession("a", "typed", "https://a.example/", 1000);
    const painted = applyState(opened, state({ painted: true }), 1900);
    expect(painted.paintMs).toBe(900);
    expect(applyState(painted, state({ painted: true }), 5000).paintMs).toBe(900);
  });

  it("times each load from its start to its finish", () => {
    const opened = newSession("a", "typed", "https://a.example/", 1000);
    const done = applyState(opened, state({ loading: false, painted: true }), 3500);
    expect(done.loadMs).toBe(2500);
    expect(done.loadStartedAt).toBeNull();
    const again = applyState(done, state({ loading: true, painted: true }), 4000);
    expect(again.loadStartedAt).toBe(4000);
    expect(again.loadMs).toBe(2500);
    expect(applyState(again, state({ loading: false, painted: true }), 4400).loadMs).toBe(400);
  });
});
