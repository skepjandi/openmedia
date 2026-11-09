import { invoke } from "@tauri-apps/api/core";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Theme = "system" | "light" | "dark";

/** The engine the command bar searches with; the address of each is in `searchEngines.ts`. */
export type SearchEngine =
  "duckDuckGo" | "google" | "bing" | "brave" | "ecosia" | "startpage" | "yahoo";

export interface Favorite {
  id: string;
  name: string;
  url: string;
  /** A small PNG data URL fetched from the site itself, when known. */
  icon?: string;
}

export interface FavoriteInput {
  name: string;
  url: string;
}

export interface AppState {
  profileId: string;
  favorites: Favorite[];
  /** Addresses the user typed, newest first. */
  history: string[];
  lastUrl: string | null;
  onboarded: boolean;
  theme: Theme;
  adBlock: boolean;
  /** Pixels kept clear under every page that has no margin of its own. */
  bottomMargin: number;
  backButton: boolean;
  aiPreview: boolean;
  /** The language the user picked, as a BCP 47 tag; null follows the device's language. */
  locale: string | null;
  searchEngine: SearchEngine;
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

/** One toggle for a site. `enabled` already reflects the user's choice or the site's default. */
export interface SiteOption {
  id: string;
  label: string;
  description: string;
  group: OptionGroup;
  enabled: boolean;
  default: boolean;
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
  /** The site runs on the user's own changed copy of the bundled recipe (a fork). */
  customized: boolean;
  /** The app now ships a different version than the one the copy was made from. */
  originalUpdated: boolean;
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
  setLastUrl: (url: string) => command("set_last_url", { url }),
  completeOnboarding: () => command("complete_onboarding"),
  resetOnboarding: () => command("reset_onboarding"),
  setTheme: (theme: Theme) => command("set_theme", { theme }),
  /** Remembers the language the user picked; null puts the app back on the device's language. */
  setLocale: (locale: string | null) => command("set_locale", { locale }),
  setSearchEngine: (engine: SearchEngine) => command("set_search_engine", { engine }),
  /** Persists the choice and reloads the open page under it; see `set_ad_block` in Rust. */
  setAdBlock: (enabled: boolean) => command("set_ad_block", { enabled }),
  /** The recipes with their toggles, from the normal choices or the incognito ones. */
  getSites: (incognito: boolean) => invoke<SiteSettings[]>("get_sites", { incognito }),
  /**
   * Saves the toggle in the normal or the incognito set; the open page reloads under it only when
   * that set is the one in play. See `set_site_option` in Rust.
   */
  setSiteOption: (recipeId: string, optionId: string, enabled: boolean, incognito: boolean) =>
    command("set_site_option", { recipeId, optionId, enabled, incognito }),
  /** Drops the changed copy so the bundled recipe applies again; see `restore_recipe_original`. */
  restoreRecipeOriginal: (recipeId: string) => command("restore_recipe_original", { recipeId }),
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
  /** Forgets the typed addresses and the remembered last page. */
  clearHistory: () => command("clear_history"),
  setBackButton: (enabled: boolean) => command("set_back_button", { enabled }),
};

export interface SectionUsage {
  /** `/` for the site's root, `*` for anything unrecognised, else `/` and the first path segment. */
  section: string;
  seconds: number;
}

export interface SiteUsage {
  host: string;
  /** The bundled recipe's name for the site, when there is one. */
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

export const app = {
  /**
   * Android's Back button and edge gesture. While a listener is registered the press goes to it
   * instead of the system; unregistering restores the system default (leave the app).
   */
  onBackButton: (handler: () => void): Promise<{ unregister: () => Promise<void> }> =>
    onBackButtonPress(() => handler()),
};
