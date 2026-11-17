import { describe, expect, it } from "vitest";
import { activeHub, hubForFavorite, tabHost, tabIndexFor } from "./hubs";
import type { HubTab, SiteSettings } from "./ipc";

const TABS: HubTab[] = [
  { label: "Posts", url: "https://www.reddit.com/r/rust/" },
  { label: "Videos", url: "https://m.youtube.com/" },
];

const site = (recipeId: string, name: string, hub: SiteSettings["hub"]): SiteSettings => ({
  recipeId,
  name,
  homepage: null,
  favorite: false,
  options: [],
  bottomMargin: null,
  origin: "user",
  author: null,
  hub,
});

describe("tabHost", () => {
  it("shows the host the page lives on", () => {
    expect(tabHost(TABS[0])).toBe("www.reddit.com");
    expect(tabHost(TABS[1])).toBe("m.youtube.com");
  });

  it("has no host for an address that is not one", () => {
    expect(tabHost({ label: "Broken", url: "nonsense" })).toBe("");
  });
});

describe("tabIndexFor", () => {
  it("finds the page the address belongs to, whatever the subdomain", () => {
    expect(tabIndexFor(TABS, "https://old.reddit.com/r/rust/new")).toBe(0);
    expect(tabIndexFor(TABS, "https://youtube.com/watch?v=1")).toBe(1);
  });

  it("keeps the page while the user walks around inside it", () => {
    expect(tabIndexFor(TABS, "https://www.reddit.com/r/rust/comments/1")).toBe(0);
  });

  it("leaves the rest of a site alone when the page points into one area of it", () => {
    const inbox: HubTab[] = [
      { label: "Instagram", url: "https://www.instagram.com/direct/inbox/" },
    ];
    expect(tabIndexFor(inbox, "https://www.instagram.com/")).toBe(-1);
    expect(tabIndexFor(inbox, "https://www.instagram.com/explore/")).toBe(-1);
    expect(tabIndexFor(inbox, "https://www.instagram.com/direct/t/123/")).toBe(0);
  });

  it("finds no page for another site or a broken address", () => {
    expect(tabIndexFor(TABS, "https://example.com/")).toBe(-1);
    expect(tabIndexFor(TABS, "nonsense")).toBe(-1);
  });
});

describe("activeHub", () => {
  const sites = [site("plain", "Plain", null), site("hub", "Reading", { tabs: TABS })];

  it("finds the hub a session was opened from, and the page it is on", () => {
    const hub = activeHub(sites, "hub", "https://www.reddit.com/r/rust/");
    expect(hub?.recipeId).toBe("hub");
    expect(hub?.name).toBe("Reading");
    expect(hub?.active).toBe(0);
    expect(hub?.tabs).toEqual(TABS);
  });

  it("keeps the hub for a session that left every page of it", () => {
    expect(activeHub(sites, "hub", "https://example.com/")?.active).toBe(-1);
    expect(activeHub(sites, "hub", null)?.active).toBe(-1);
  });

  it("finds no hub for a session that is not a hub session, even on a hub page's site", () => {
    expect(activeHub(sites, null, "https://www.reddit.com/r/rust/")).toBeNull();
  });

  it("finds no hub for an ordinary recipe or one that is gone", () => {
    expect(activeHub(sites, "plain", "https://www.reddit.com/")).toBeNull();
    expect(activeHub(sites, "removed", "https://www.reddit.com/")).toBeNull();
  });

  it("does not mix two hubs that share a site", () => {
    const twice = [
      site("first", "First", { tabs: TABS }),
      site("second", "Second", { tabs: TABS }),
    ];
    expect(activeHub(twice, "second", "https://m.youtube.com/")?.recipeId).toBe("second");
  });
});

describe("hubForFavorite", () => {
  const withHome = (
    recipeId: string,
    homepage: string,
    hub: SiteSettings["hub"],
  ): SiteSettings => ({
    ...site(recipeId, recipeId, hub),
    homepage,
  });
  const messages = withHome("messages", "https://web.whatsapp.com/", {
    tabs: [{ label: "WhatsApp", url: "https://web.whatsapp.com/" }],
  });

  it("opens a hub's homepage favorite as that hub", () => {
    expect(hubForFavorite([messages], "https://web.whatsapp.com/")?.recipeId).toBe("messages");
  });

  it("leaves a favorite of an ordinary recipe or an unknown site alone", () => {
    const instagram = withHome("instagram", "https://www.instagram.com/", null);
    expect(hubForFavorite([messages, instagram], "https://www.instagram.com/")).toBeUndefined();
    expect(hubForFavorite([messages], "https://example.com/")).toBeUndefined();
  });

  it("lets a single-site recipe that owns the homepage win over a hub", () => {
    const whatsapp = withHome("whatsapp", "https://web.whatsapp.com/", null);
    expect(hubForFavorite([messages, whatsapp], "https://web.whatsapp.com/")).toBeUndefined();
  });
});
