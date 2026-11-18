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
  /** The speed and sound last chosen, applied to the next video. */
  remember?: boolean;
  /** Stops a video from restarting by itself when it ends. */
  loopOff?: boolean;
  /** Scrolls on to the next video when one ends. */
  autoAdvance?: boolean;
}

export type DarkMethod = "dynamic" | "filter" | "filterplus" | "static";
export type DarkScheduleKind = "always" | "system" | "time";

/** When dark mode is active. `from` and `to` are `HH:MM` in the device's local time and only matter for `time`. */
export interface DarkSchedule {
  kind: DarkScheduleKind;
  from: string;
  to: string;
}

/** How pages are darkened, for every site without a choice of its own. */
export interface DarkMode {
  enabled: boolean;
  method: DarkMethod;
  /** Percent, 50 to 150. */
  brightness: number;
  /** Percent, 50 to 150. */
  contrast: number;
  /** Percent, 0 to 100. */
  sepia: number;
  /** Percent, 0 to 100. */
  grayscale: number;
  /** `#rrggbb`, lowercase. */
  background: string;
  /** `#rrggbb`, lowercase. */
  text: string;
  schedule: DarkSchedule;
  /** Leaves a page that is already dark alone. */
  skipDarkPages: boolean;
  /** Dark scrollbars, form controls and default colours. */
  systemControls: boolean;
  scrollbars: boolean;
  /** Inverts dark transparent icons and tones down large light diagrams. */
  images: boolean;
  /** Tenths of a pixel, 0 to 10. */
  textStroke: number;
}

/** One site's own dark mode choice (by registrable domain); a field that is missing follows the shared one. */
export interface SiteDark {
  /** `on` forces dark mode on whatever the schedule says; `off` keeps it off. */
  mode?: "on" | "off";
  method?: DarkMethod;
  /** Percent, 50 to 150. */
  brightness?: number;
  /** Percent, 50 to 150. */
  contrast?: number;
  /** Percent, 0 to 100. */
  sepia?: number;
  /** Percent, 0 to 100. */
  grayscale?: number;
  /** `#rrggbb`. */
  background?: string;
  /** `#rrggbb`. */
  text?: string;
  /** Replaces the shared schedule as a whole. */
  schedule?: DarkSchedule;
  skipDarkPages?: boolean;
  systemControls?: boolean;
  scrollbars?: boolean;
  images?: boolean;
  /** Tenths of a pixel, 0 to 10. */
  textStroke?: number;
}

export interface Favorite {
  id: string;
  name: string;
  url: string;
  /** A small PNG data URL fetched from the site itself, when known. */
  icon?: string;
  /** Whether a rise in the page's unread count raises a local notification. */
  notify: boolean;
  /** Where a new session of this favorite starts instead of `url`; always on the favorite's own site. */
  landing?: string;
  /** The folder it is filed in; favorites that share a name share a folder. Loose when absent. */
  folder?: string;
}

export interface FavoriteInput {
  name: string;
  url: string;
  /** Left out, it is on: Rust's default, and what every new favorite gets. */
  notify?: boolean;
  /** An address or a path on the favorite's site; left out or null, the favorite opens `url`. */
  landing?: string | null;
  /** A folder name; left out, blank or null, the favorite is loose. */
  folder?: string | null;
}

/** A folder the user manages: a name and, when chosen, an emoji icon. Without one it shows what is in it. */
export interface Folder {
  name: string;
  icon?: string;
}

export interface AppState {
  profileId: string;
  favorites: Favorite[];
  /** The folders, including empty ones; favorites name the folder they are in. */
  folders: Folder[];
  /** Addresses the user typed, newest first. */
  history: string[];
  lastUrl: string | null;
  /** The pages behind `lastUrl`, oldest first. */
  lastBack: string[];
  onboarded: boolean;
  theme: Theme;
  adBlock: boolean;
  /** Drops pop-ups and redirects that are no sign-in; in force only while `adBlock` is on. */
  blockPopups: boolean;
  /** Pixels kept clear under every page that has no margin of its own. */
  bottomMargin: number;
  /** The sites (registrable domains) whose media keeps playing while hidden or in the background. */
  backgroundMediaSites: string[];
  /** The sites (registrable domains) whose videos may open in a picture-in-picture window. */
  pictureInPictureSites: string[];
  /** The sites (registrable domains) asked for their desktop page. Off for every other site. */
  desktopSites: string[];
  backButton: boolean;
  /** The color picker on the floating button's fan. On unless the user turned it off. */
  colorPicker: boolean;
  /** The technology detector on the fan. Off unless the user turned it on. */
  techDetector: boolean;
  aiPreview: boolean;
  /** The language the user picked, as a BCP 47 tag; null follows the device's language. */
  locale: string | null;
  searchEngine: SearchEngine;
  accessibility: Accessibility;
  videoControls: VideoControls;
  /** Per-site video controls choices by registrable domain. */
  videoSites: Record<string, SiteVideo>;
  darkMode: DarkMode;
  /** Per-site dark mode choices by registrable domain. */
  darkSites: Record<string, SiteDark>;
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
  /** Who made the recipe (its `meta.author`); null when it names no one. */
  author: string | null;
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

export type TechCategory =
  "framework" | "platform" | "analytics" | "service" | "design" | "delivery";

/** A technology the page shows signs of. Names come from Rust's own table, never from the page. */
export interface DetectedTech {
  name: string;
  category: TechCategory;
}

/** Asks what the page in front is built with. */
export const techDetect = {
  run: () => invoke<DetectedTech[]>("tech_detect"),
};

/** What the picking layer on the page has found; `hex` is `#rrggbb`, lowercase. While waiting it is the color under the loupe. */
export type ColorReading =
  | { status: "idle" | "cancelled" }
  | { status: "waiting"; hex: string | null }
  | { status: "done"; hex: string };

/** The color picker: a loupe on the page in front, dragged over a color and accepted. */
export const colorPick = {
  start: () => command("color_pick_start"),
  read: () => invoke<ColorReading>("color_pick_read"),
  accept: () => invoke<ColorReading>("color_pick_accept"),
  cancel: () => command("color_pick_cancel"),
};

/** Where a search of the page in front stands. `index` counts from 1 and is 0 with no match. */
export interface FindResult {
  count: number;
  index: number;
  /** The page has more matches than `count` shows. */
  capped: boolean;
}

/** Find in page, and the other actions on the page in front that a browser's menu offers. */
export const pageTools = {
  find: (query: string) => invoke<FindResult>("find_in_page", { query }),
  findStep: (forward: boolean) => invoke<FindResult>("find_in_page_step", { forward }),
  findClear: () => command("find_in_page_clear"),
  /** Opens the system share sheet (phones and tablets; desktop copies the address instead). */
  share: (url: string, title: string | null) => command("share_page", { url, title }),
  /** Erases one site's cookies, storage and cache from the page's profile, then reloads it. */
  clearSiteData: (site: string) => command("clear_site_data", { site }),
};

export type PageScroll =
  | "down"
  | "up"
  | "left"
  | "right"
  | "halfDown"
  | "halfUp"
  | "pageDown"
  | "pageUp"
  | "top"
  | "bottom";

/** A menu item the shell asks the desktop menu bar to show, with the keys that run it. */
export interface MenuShortcut {
  id: string;
  label: string;
  group: string;
  accelerator: string | null;
}

/** Desktop keyboard control: the page in front, the keyboard's owner and the menu bar's accelerators. */
export const keyboard = {
  scroll: (scroll: PageScroll) => command("page_scroll", { scroll }),
  zoom: (zoom: "in" | "out" | "reset") => command("page_zoom", { zoom }),
  /** Gives the keyboard to the page in front, or to the shell so its shortcuts see every key. */
  focus: (target: "page" | "shell") => command("focus_keyboard", { target }),
  setMenuShortcuts: (shortcuts: MenuShortcut[]) => command("set_menu_shortcuts", { shortcuts }),
  onMenuAction: (handler: (id: string) => void): Promise<UnlistenFn> =>
    listen<string>("menu:action", (event) => handler(event.payload)),
};

export interface ImportPreview {
  bookmarks: number;
  history: number;
  passwords: number;
  passwordSites: number;
  searchEngine: SearchEngine | null;
  recipes: { recipeId: string; name: string; site: string }[];
  sites: { site: string; name: string }[];
}

export interface ImportChoices {
  recipes: string[];
  sites: string[];
  history: boolean;
  searchEngine: boolean;
  passwords: boolean;
}

export interface ImportResult {
  recipes: number;
  favorites: number;
  history: number;
  searchEngine: boolean;
  passwords: number;
}

/** Bringing in what another browser exported. Passwords never come back from Rust in a preview. */
export const importer = {
  /** Sends one exported file's text; answers with everything read so far. */
  read: (text: string) => invoke<ImportPreview>("import_read", { text }),
  cancel: () => command("import_cancel"),
  apply: (choices: ImportChoices) => invoke<ImportResult>("import_apply", { choices }),
};

/** A saved login without its password. */
export interface VaultLogin {
  id: string;
  site: string;
  origin: string;
  name: string;
  username: string;
}

export interface VaultFilled {
  username: boolean;
  password: boolean;
}

/** The vault of imported logins. Everything but `countForPage` needs an unlock by the device owner. */
export const vault = {
  /** Asks for Face ID, a fingerprint or the device passcode; `false` when they declined. */
  unlock: (reason: string) => invoke<boolean>("vault_unlock", { reason }),
  lock: () => command("vault_lock"),
  list: () => invoke<VaultLogin[]>("vault_list"),
  /** How many logins are saved for the page's site; a number only, no unlock. */
  countForPage: (url: string) => invoke<number>("vault_count_for_page", { url }),
  matches: (url: string) => invoke<VaultLogin[]>("vault_matches", { url }),
  reveal: (id: string) => invoke<string>("vault_reveal", { id }),
  remove: (id: string) => command("vault_delete", { id }),
  clear: () => command("vault_clear"),
  /** Puts the login in the page's username and password fields; submits nothing. */
  fill: (id: string, url: string) => invoke<VaultFilled>("vault_fill", { id, url }),
};

export type DownloadKind = "image" | "video" | "audio" | "document" | "archive" | "other";
export type DownloadStatus = "queued" | "downloading" | "paused" | "done" | "failed" | "cancelled";

/** One file being fetched, or fetched. */
export interface Download {
  id: string;
  url: string;
  fileName: string;
  /** Where the finished file is, or will be. */
  path: string | null;
  kind: DownloadKind;
  status: DownloadStatus;
  received: number;
  total: number | null;
  /** Bytes per second while downloading. */
  speed: number;
  /** Whether pausing keeps what has arrived. */
  resumable: boolean;
  error: string | null;
  site: string;
  addedAt: number;
  finishedAt: number | null;
  /** Started in incognito: never saved, gone when incognito ends. */
  private: boolean;
}

/** A rule renames and routes the files it matches; the first enabled match wins. */
export interface DownloadRule {
  id: string;
  name: string;
  enabled: boolean;
  /** The site or a parent domain of it. */
  host: string | null;
  /** Empty means any kind. */
  kinds: DownloadKind[];
  /** A regular expression the address must contain a match for. */
  regex: string | null;
  mask: string | null;
  /** A subfolder of the download folder; naming tokens work here too. */
  folder: string | null;
}

export interface DownloadSettings {
  /** The downloads button on the floating button's fan. */
  button: boolean;
  mask: string;
  /** Connections per large file, 1 to 8. */
  segments: number;
  /** Where files go; null is the device's downloads folder. */
  folder: string | null;
  rules: DownloadRule[];
}

export interface DownloadsSnapshot {
  settings: DownloadSettings;
  downloads: Download[];
  defaultFolder: string;
}

/** One address to download. */
export interface DownloadRequest {
  url: string;
  label?: string;
  kind?: DownloadKind;
  pageUrl?: string;
  pageTitle?: string;
}

/** A link, image, video or audio found on the page in front. */
export interface FoundMedia {
  url: string;
  kind: DownloadKind;
  label: string;
  width: number;
  height: number;
}

export interface SniffedPage {
  page: { url: string; title: string };
  items: FoundMedia[];
}

export type DownloadPreview =
  { kind: "image"; dataUri: string } | { kind: "text"; text: string } | { kind: "none" };

/** The download manager. Everything runs in Rust; the shell asks and listens. */
export const downloads = {
  state: () => invoke<DownloadsSnapshot>("downloads_state"),
  setSettings: (settings: DownloadSettings) =>
    invoke<DownloadSettings>("downloads_set_settings", { settings }),
  add: (requests: DownloadRequest[]) => invoke<Download[]>("downloads_add", { requests }),
  /** One address per line; `[001-020]` in an address stands for the whole range. */
  addText: (text: string, page?: { url: string; title: string }) =>
    invoke<Download[]>("downloads_add_text", {
      text,
      pageUrl: page?.url ?? null,
      pageTitle: page?.title ?? null,
    }),
  pause: (id: string) => command("downloads_pause", { id }),
  resume: (id: string) => command("downloads_resume", { id }),
  cancel: (id: string) => command("downloads_cancel", { id }),
  remove: (id: string) => command("downloads_remove", { id }),
  clearFinished: () => command("downloads_clear_finished"),
  open: (id: string) => command("downloads_open", { id }),
  reveal: (id: string) => command("downloads_reveal", { id }),
  preview: (id: string) => invoke<DownloadPreview>("downloads_preview", { id }),
  /** A small picture of an image address, or null when it is not a small image. */
  thumbnail: (url: string, pageUrl?: string) =>
    invoke<string | null>("downloads_thumbnail", { url, pageUrl: pageUrl ?? null }),
  /** Lists what the page in front offers to download. */
  sniff: () => invoke<SniffedPage>("downloads_sniff"),
  onChanged: (handler: (download: Download) => void): Promise<UnlistenFn> =>
    listen<Download>("downloads:changed", (event) => handler(event.payload)),
};

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
  setFolders: (folders: Folder[]) => invoke<Folder[]>("set_folders", { folders }),
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
  /** Persists the choice; pages opened afterwards use it. */
  setBlockPopups: (enabled: boolean) => command("set_block_popups", { enabled }),
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
  /** Asks a site for its desktop page; off for every site by default. */
  setSiteDesktop: (site: string, enabled: boolean) =>
    command("set_site_desktop", { site, enabled }),
  /** Saves one site's video controls choice; an empty choice returns the site to the shared one. */
  setSiteVideoControls: (site: string, video: SiteVideo) =>
    command("set_site_video_controls", { site, video }),
  setBottomMargin: (pixels: number) => command("set_bottom_margin", { pixels }),
  /** Saves one site's dark mode choice; an empty choice returns the site to the shared one. */
  setSiteDarkMode: (site: string, dark: SiteDark) => command("set_site_dark_mode", { site, dark }),
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
  setColorPicker: (enabled: boolean) => command("set_color_picker", { enabled }),
  setTechDetector: (enabled: boolean) => command("set_tech_detector", { enabled }),
  setAccessibility: (accessibility: Accessibility) =>
    command("set_accessibility", { accessibility }),
  setVideoControls: (videoControls: VideoControls) =>
    command("set_video_controls", { videoControls }),
  setDarkMode: (darkMode: DarkMode) => command("set_dark_mode", { darkMode }),
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
  /** A page of the shell's own (a new tab) covers the page in front: its media is held. */
  setCovered: (covered: boolean) =>
    command("plugin:siteview|set_covered", { request: { covered } }),
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
  /** A pop-up or redirect the page made on its own was dropped; the payload is the host it wanted. */
  onPopupBlocked: (handler: (host: string) => void): Promise<UnlistenFn> =>
    listen<string>("siteview:popup-blocked", (event) => handler(event.payload)),
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
