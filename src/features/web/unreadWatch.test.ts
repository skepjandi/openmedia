import { describe, expect, it } from "vitest";
import type { Favorite } from "../../shared/ipc";
import { newSession, applyState, type Session } from "./sessions";
import {
  NOTIFY_MIN_GAP_MS,
  observeTitle,
  quickFavoriteOf,
  unreadByFavorite,
  type Watch,
} from "./unreadWatch";

const fresh = (count: number): Watch => ({ count, notifiedAt: -Infinity });

describe("observeTitle", () => {
  it("takes the first title as a baseline", () => {
    expect(observeTitle(undefined, "(3) Messenger", true, 0)).toEqual({
      watch: fresh(3),
      notify: false,
    });
  });

  it("changes nothing while the title is unknown", () => {
    const seen = fresh(2);
    expect(observeTitle(seen, null, true, 0)).toEqual({ watch: seen, notify: false });
    expect(observeTitle(undefined, null, true, 0).watch.count).toBe(0);
  });

  it("notifies when a hidden page's count rises", () => {
    const step = observeTitle(fresh(0), "(1) Messenger", true, 100);
    expect(step.notify).toBe(true);
    expect(step.watch).toEqual({ count: 1, notifiedAt: 100 });
  });

  it("stays quiet for the page on screen but keeps counting", () => {
    expect(observeTitle(fresh(0), "(2) Messenger", false, 100)).toEqual({
      watch: fresh(2),
      notify: false,
    });
  });

  it("does not repeat for a count that did not rise", () => {
    expect(observeTitle(fresh(3), "(3) Messenger", true, 100).notify).toBe(false);
    const read = observeTitle(fresh(3), "Messenger", true, 100);
    expect(read).toEqual({ watch: fresh(0), notify: false });
    expect(observeTitle(read.watch, "(1) Messenger", true, 200).notify).toBe(true);
  });

  it("limits how often one page can notify", () => {
    const first = observeTitle(fresh(0), "(1) Messenger", true, 1_000);
    const early = observeTitle(first.watch, "(2) Messenger", true, 1_000 + NOTIFY_MIN_GAP_MS - 1);
    expect(early.notify).toBe(false);
    expect(early.watch.notifiedAt).toBe(1_000);
    const later = observeTitle(early.watch, "(3) Messenger", true, 1_000 + NOTIFY_MIN_GAP_MS);
    expect(later.notify).toBe(true);
  });
});

const favorite = (id: string, name: string, url: string): Favorite => ({
  id,
  name,
  url,
  notify: true,
});

function session(id: string, url: string, title: string | null): Session {
  const opened = newSession(id, "favorite", url, 0);
  return applyState(opened, {
    session: id,
    url,
    title,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    painted: true,
    scope: new URL(url).hostname.replace(/^(www|m)\./, ""),
  });
}

describe("quick-access lookups", () => {
  const favorites = [
    favorite("a", "Messenger", "https://www.messenger.com/"),
    favorite("b", "Reddit", "https://www.reddit.com/"),
  ];
  const sessions = [
    session("s1", "https://www.messenger.com/", "(4) Messenger"),
    session("s2", "https://www.reddit.com/", "(2) Reddit"),
    session("s3", "https://example.org/", "(7) Example"),
  ];

  it("finds the favorite a session belongs to, and none for other pages", () => {
    expect(quickFavoriteOf(sessions, favorites, "s1")?.name).toBe("Messenger");
    expect(quickFavoriteOf(sessions, favorites, "s3")).toBeUndefined();
  });

  it("leaves out favorites beyond quick access", () => {
    const many = [
      ...Array.from({ length: 6 }, (_, i) => favorite(`f${i}`, `F${i}`, `https://f${i}.test/`)),
      favorites[0],
    ];
    expect(quickFavoriteOf(sessions, many, "s1")).toBeUndefined();
  });

  it("badges hidden favorite sessions in menu order and never the active one", () => {
    expect(unreadByFavorite(sessions, favorites, "s2")).toEqual([4, 0]);
    expect(unreadByFavorite(sessions, favorites, null)).toEqual([4, 2]);
    expect(unreadByFavorite([], favorites, null)).toEqual([0, 0]);
  });
});
