import { describe, expect, it } from "vitest";
import { activeHub, tabHost, tabIndexFor } from "./hubs";
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

  it("finds no page for another site or a broken address", () => {
    expect(tabIndexFor(TABS, "https://example.com/")).toBe(-1);
    expect(tabIndexFor(TABS, "nonsense")).toBe(-1);
  });
});

describe("activeHub", () => {
  const sites = [site("plain", "Plain", null), site("hub", "Reading", { tabs: TABS })];

  it("finds the hub the page belongs to", () => {
    const hub = activeHub(sites, "https://www.reddit.com/r/rust/");
    expect(hub?.recipeId).toBe("hub");
    expect(hub?.name).toBe("Reading");
    expect(hub?.active).toBe(0);
    expect(hub?.tabs).toEqual(TABS);
  });

  it("finds no hub for a page of an ordinary recipe or of another site", () => {
    expect(activeHub(sites, "https://example.com/")).toBeNull();
    expect(activeHub(sites, null)).toBeNull();
  });

  it("finds no hub when no hub is installed", () => {
    expect(activeHub([site("plain", "Plain", null)], "https://www.reddit.com/")).toBeNull();
  });

  it("takes the first hub with a page on the site's own site", () => {
    const twice = [
      site("first", "First", { tabs: TABS }),
      site("second", "Second", { tabs: TABS }),
    ];
    expect(activeHub(twice, "https://m.youtube.com/")?.recipeId).toBe("first");
  });
});
