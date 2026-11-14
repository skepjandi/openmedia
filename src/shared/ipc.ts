import { invoke } from "@tauri-apps/api/core";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Theme = "system" | "light" | "dark";

/** The engine the command bar searches with; the address of each is in `searchEngines.ts`. */
export type SearchEngine =
  "duckDuckGo" | "google" | "bing" | "brave" | "ecosia" | "startpage" | "yahoo";

/** A reading font for pages and the app: `off` leaves each page's own. */
export type ReadingFont = "off" | "opendyslexic" | "hyperlegible";

/** A pastel laid over the page to cut glare. */
export type Tint = "off" | "cream" | "mint" | "blue";

/** Epilepsy protection and the reading aids for dyslexia; all off until chosen. */
export interface Accessibility {
  /** Stops animation, transitions, autoplaying video and animated GIFs. */
  epilepsyProtection: boolean;
  font: ReadingFont;
  /** Wider letters, words and lines. */
  spacing: boolean;
  tint: Tint;
}

/** What the user chose for the video in view in a full-screen feed, for every site without a choice of its own. */
export interface VideoControls {
  /** OpenMedia's panel on a tap (pause, skip 6 s, mute, speed, seek bar) in place of the site's own tap. On until switched off. */
  panel: boolean;
  /** Pixels between the panel and the bottom of the page. */
  height: number;
  /** The panel on watch pages too, in place of the site's own player controls. Off by default. */
  fullVideos: boolean;
  /** The speed and sound last chosen, applied to the next video. */
  remember: boolean;
  /** Stops a video from restarting by itself when it ends. */
  loopOff: boolean;
  /** Scrolls on to the next video when one ends. */
  autoAdvance: boolean;
}

/** One site's own choice (by registrable domain); a field that is missing follows the shared one. */
export interface SiteVideo {
  /** `false` gives the site its own controls back. */
  panel?: boolean;
  height?: number;
  fullVideos?: boolean;
}

export interface Favorite {
  id: string;
  name: string;
  url: string;
  /** A small PNG data URL fetched from the site itself, when known. */
  icon?: string;
  /** Whether a rise in the page's unread count raises a local notification. */
  notify: boolean;
}

export interface FavoriteInput {
  name: string;
  url: string;
  /** Left out, it is on: Rust's default, and what every new favorite gets. */
  notify?: boolean;
}

export interface AppState {
  profileId: string;
  favorites: Favorite[];
  /** Addresses the user typed, newest first. */
  history: string[];
  lastUrl: string | null;
  /** The pages behind `lastUrl`, oldest first. */
  lastBack: string[];
  onboarded: boolean;
  theme: Theme;
  adBlock: boolean;
  /** Pixels kept clear under every page that has no margin of its own. */
  bottomMargin: number;
  /** The sites (registrable domains) whose media keeps playing while hidden or in the background. */
  backgroundMediaSites: string[];
  /** The sites (registrable domains) whose videos may open in a picture-in-picture window. */
  pictureInPictureSites: string[];
  backButton: boolean;
  aiPreview: boolean;
  /** The language the user picked, as a BCP 47 tag; null follows the device's language. */
  locale: string | null;
  searchEngine: SearchEngine;
  accessibility: Accessibility;
  videoControls: VideoControls;
  /** Per-site video controls choices by registrable domain. */
  videoSites: Record<string, SiteVideo>;
}

/** The page Rust already started loading at launch; the shell takes it over. */
export interface BootSession {
  id: string;
  url: string;
}

/** `get_state`: the saved state plus the page opened for it, if there is one. */
export interface Startup extends AppState {
  bootSession: BootSession | null;
  /** The page is a view beside the shell, not a layer under it: the shell lays out around it. */
  desktop: boolean;
}

export type OptionGroup = "annoyance" | "content";

/** One state of a choice option, such as Show, Blur or Hide. */
export interface OptionChoice {
  id: string;
  label: string;
}

/** An on/off switch is a boolean; a choice option holds the id of one of its choices. */
export type OptionValue = boolean | string;

/**
 * One setting for a site. `value` already reflects the user's choice or the site's default.
 * `choices` is empty for an on/off switch; otherwise it lists the states in order, and the first
 * one leaves the page alone.
 */
export interface SiteOption {
  id: string;
  label: string;
  description: string;
  group: OptionGroup;
  choices: OptionChoice[];
  value: OptionValue;
  default: OptionValue;
}

/** One page of a hub: the label on its tab and the address it opens. */
export interface HubTab {
  label: string;
  url: string;
}

/** A recipe that opens as several pages at once, each on a site of its own. */
export interface Hub {
  tabs: HubTab[];
}

export interface SiteSettings {
  recipeId: string;
  name: string;
  /** Where a favorite of this site opens; null means it cannot be favorited. */
  homepage: string | null;
  /** Whether any favorite opens this site. */
  favorite: boolean;
  options: SiteOption[];
  /** The site's own bottom margin, or null to use the shared one. */
  bottomMargin: number | null;
  /** Who the recipe is from; `imported` (a pasted bundle or the recipe library) can be removed. */
  origin: "user" | "ai" | "imported";
  /** The pages this recipe opens as tabs; null for an ordinary recipe. */
  hub: Hub | null;
}

export type ProviderKind = "anthropic" | "openAiCompatible";

/** A provider as the shell sees it. There is no key field: keys never come back from Rust. */
export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string | null;
  hasKey: boolean;
}

export interface ProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model?: string | null;
}

export interface AiState {
  providers: Provider[];
  activeId: string | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SiteViewState {
  session: string;
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** The page has drawn its first content and is showing. */
  painted: boolean;
  /** The registrable domain the session is pinned to. */
  scope: string;
}

/** What the web layer and the native app are, as far as updates go. */
export interface UpdateStatus {
  /** The native app's version; a downloaded web bundle runs only on the version it was built for. */
  runtimeVersion: string;
  /** The downloaded web bundle the shell runs from; null for the one inside the app. */
  runningRevision: number | null;
  /** A downloaded web bundle that starts with the next launch. */
  pendingRevision: number | null;
  /** Whether this build can replace itself; false for store builds, which the store updates. */
  selfUpdate: boolean;
}

export type WebUpdateOutcome = { kind: "upToDate" } | { kind: "staged"; revision: number };

export interface AppUpdate {
  version: string;
  notes: string | null;
}

async function command(name: string, args?: Record<string, unknown>): Promise<void> {
  await invoke(name, args);
}

let startupRequest: Promise<Startup> | null = null;

/** Asks for the startup state now, so the answer is on its way while the shell renders. */
export function prefetchStartup(): void {
  startupRequest ??= invoke<Startup>("get_state");
}

export const library = {
  /** The startup state: the one `prefetchStartup` asked for, if it is still unclaimed. */
  getState: (): Promise<Startup> => {
    const request = startupRequest ?? invoke<Startup>("get_state");
    startupRequest = null;
    return request;
  },
  setFavorites: (favorites: FavoriteInput[]) => invoke<Favorite[]>("set_favorites", { favorites }),
  /** Adds a recipe's site to the favorites, or removes the site's favorites. */
  setSiteFavorite: (recipeId: string, favorite: boolean) =>
    invoke<Favorite[]>("set_site_favorite", { recipeId, favorite }),
  icons: () => invoke<Record<string, string>>("get_icons"),
  refreshIcons: (urls: string[]) => invoke<Record<string, string>>("refresh_icons", { urls }),
  setLastUrl: (url: string, back: string[]) => command("set_last_url", { url, back }),
  completeOnboarding: () => command("complete_onboarding"),
  resetOnboarding: () => command("reset_onboarding"),
  /** Opens an https address in the system browser; for links in the shell's own UI. */
  openExternal: (url: string) => command("open_external", { url }),
  setTheme: (theme: Theme) => command("set_theme", { theme }),
  /** Remembers the language the user picked; null puts the app back on the device's language. */
  setLocale: (locale: string | null) => command("set_locale", { locale }),
  setSearchEngine: (engine: SearchEngine) => command("set_search_engine", { engine }),
  /** Persists the choice and reloads the open page under it; see `set_ad_block` in Rust. */
  setAdBlock: (enabled: boolean) => command("set_ad_block", { enabled }),
  /** The recipes with their toggles, from the normal choices or the incognito ones. */
  getSites: (incognito: boolean) => invoke<SiteSettings[]>("get_sites", { incognito }),
  /**
   * Saves the setting (a switch's boolean or a choice id) in the normal or the incognito set; the
   * open page reloads under it only when that set is the one in play. See `set_site_option` in
   * Rust.
   */
  setSiteOption: (recipeId: string, optionId: string, value: OptionValue, incognito: boolean) =>
    command("set_site_option", { recipeId, optionId, value, incognito }),
  /** Lets a site's media keep playing while hidden or in the background; every site pauses by default. */
  setSiteBackgroundMedia: (site: string, enabled: boolean) =>
    command("set_site_background_media", { site, enabled }),
  /** Lets a site's videos open in a picture-in-picture window; off for every site by default. */
  setSitePictureInPicture: (site: string, enabled: boolean) =>
    command("set_site_picture_in_picture", { site, enabled }),
  /** Saves one site's video controls choice; an empty choice returns the site to the shared one. */
  setSiteVideoControls: (site: string, video: SiteVideo) =>
    command("set_site_video_controls", { site, video }),
  setBottomMargin: (pixels: number) => command("set_bottom_margin", { pixels }),
  setSiteBottomMargin: (recipeId: string, pixels: number | null) =>
    command("set_site_bottom_margin", { recipeId, pixels }),
  /** The margin that applies to this page: its site's own, else the shared one. */
  bottomMarginFor: (url: string) => invoke<number>("bottom_margin_for", { url }),
  /**
   * Opens the page natively as a new session, with the recipe script attached, and shows it.
   * Earlier sessions stay open; see `open_site` in Rust.
   */
  openSite: (session: string, url: string, rect: Rect) =>
    command("open_site", { session, url, rect }),
  /**
   * Takes over the page Rust opened at launch: gives it the real rectangle and re-announces its
   * state. If that page is gone, opens `url` instead; see `adopt_boot_session` in Rust.
   */
  adoptBootSession: (session: string, url: string, rect: Rect) =>
    command("adopt_boot_session", { session, url, rect }),
  /** Remembers a typed address and returns the history, newest first. */
  addHistory: (url: string) => invoke<string[]>("add_history", { url }),
  /** Forgets one typed address and returns the history that remains, newest first. */
  removeHistory: (url: string) => invoke<string[]>("remove_history", { url }),
  /** Forgets the typed addresses and the remembered last page. */
  clearHistory: () => command("clear_history"),
  setBackButton: (enabled: boolean) => command("set_back_button", { enabled }),
  setAccessibility: (accessibility: Accessibility) =>
    command("set_accessibility", { accessibility }),
  setVideoControls: (videoControls: VideoControls) =>
    command("set_video_controls", { videoControls }),
};

export interface SectionUsage {
  /** `/` for the site's root, `*` for anything unrecognised, else `/` and the first path segment. */
  section: string;
  seconds: number;
}

export interface SiteUsage {
  host: string;
  /** The installed recipe's name for the site, when there is one. */
  name: string | null;
  seconds: number;
  sections: SectionUsage[];
}

export interface UsageReport {
  totalSeconds: number;
  /** Busiest first. */
  sites: SiteUsage[];
}

/** Time on sites, kept in `usage.json` on this device; see `usage.rs`. */
export const usage = {
  record: (day: string, host: string, section: string, seconds: number) =>
    command("record_usage", { day, host, section, seconds }),
  report: (today: string, days: number) => invoke<UsageReport>("get_usage", { today, days }),
  clear: () => command("clear_usage"),
};

export const ai = {
  state: () => invoke<AiState>("ai_state"),
  saveProvider: (provider: ProviderInput) => invoke<Provider>("ai_save_provider", { provider }),
  deleteProvider: (id: string) => command("ai_delete_provider", { id }),
  /** The only place a key leaves the shell: straight to Rust and the Keychain, once. */
  setKey: (id: string, key: string) => command("ai_set_key", { id, key }),
  removeKey: (id: string) => command("ai_remove_key", { id }),
  setActive: (id: string | null) => command("ai_set_active", { id }),
  /** Asks the provider for its models; proves the key works. */
  test: (id: string) => invoke<string[]>("ai_test", { id }),
};

export const siteView = {
  activate: (session: string) => command("plugin:siteview|activate", { request: { session } }),
  close: (session: string) => command("plugin:siteview|close", { request: { session } }),
  setRect: (rect: Rect) => command("plugin:siteview|set_rect", { request: { rect } }),
  setInteractiveRegions: (regions: Rect[]) =>
    command("plugin:siteview|set_interactive_regions", { request: { regions } }),
  setColorScheme: (scheme: Theme) =>
    command("plugin:siteview|set_color_scheme", { request: { scheme } }),
  goBack: () => command("plugin:siteview|go_back"),
  goForward: () => command("plugin:siteview|go_forward"),
  reload: () => command("plugin:siteview|reload"),
  /** A local notification for a hidden session. The text is the app's own, never page text. */
  notify: (session: string, title: string, body: string) =>
    command("plugin:siteview|notify", { request: { session, title, body } }),
  onState: (handler: (state: SiteViewState) => void): Promise<UnlistenFn> =>
    listen<SiteViewState>("siteview:state", (event) => handler(event.payload)),
  /** A session the native side dropped by itself, for example after its web process died. */
  onClosed: (handler: (session: string) => void): Promise<UnlistenFn> =>
    listen<string>("siteview:closed", (event) => handler(event.payload)),
  /** The OS asked the app to give memory back. */
  onMemoryWarning: (handler: () => void): Promise<UnlistenFn> => listen("siteview:memory", handler),
  /** The user tapped a notification; the payload is the session it was raised for. */
  onNotificationTap: (handler: (session: string) => void): Promise<UnlistenFn> =>
    listen<string>("siteview:notification-tap", (event) => handler(event.payload)),
  onError: (handler: (message: string) => void): Promise<UnlistenFn> =>
    listen<string>("siteview:error", (event) => handler(event.payload)),
};

export const updates = {
  status: () => invoke<UpdateStatus>("ota_status"),
  /** The shell has rendered from the running web bundle; stops it counting as unproven. */
  confirm: () => command("ota_confirm"),
  /** Downloads a newer web bundle, if there is one; it takes effect on the next launch. */
  checkWeb: () => invoke<WebUpdateOutcome>("ota_check"),
  checkApp: () => invoke<AppUpdate | null>("app_update_check"),
  /** Installs the new app version and restarts. */
  installApp: () => command("app_update_install"),
};

export const app = {
  /**
   * Android's Back button and edge gesture. While a listener is registered the press goes to it
   * instead of the system; unregistering restores the system default (leave the app).
   */
  onBackButton: (handler: () => void): Promise<{ unregister: () => Promise<void> }> =>
    onBackButtonPress(() => handler()),
};
