import { create } from "zustand";
import { usableQuickAccess } from "../shared/favorites";
import {
  assistantReducer,
  initialAssistant,
  pendingJobId,
  type AssistantEvent,
  type AssistantState,
} from "../features/ai/flow";
import { earlierOf } from "../features/ai/chat";
import { selectActiveChat, useChat } from "../features/ai/chatStore";
import { assistant as assistantIpc, type PreparedRequest } from "../features/ai/ipc";
import { hubForFavorite } from "../shared/hubs";
import { siteOf } from "../shared/site";
import { incognito as incognitoIpc } from "../features/incognito/ipc";
import {
  applyState,
  findFavoriteSession,
  findTypedSession,
  newSession,
  startSource,
  sessionsToClose,
  type Pressure,
  type Session,
  type SessionSource,
} from "../features/web/sessions";
import {
  ai,
  library,
  siteView,
  type Accessibility,
  type SiteVideo,
  type VideoControls,
  type AiState,
  type AppState,
  type Favorite,
  type FavoriteInput,
  type OptionValue,
  type SearchEngine,
  type SiteSettings,
  type SiteViewState,
  type Theme,
} from "../shared/ipc";
import { hiddenTabIds, tabAfterClose } from "../features/tabs/tabs";
import { useEntitlementStore } from "../features/paywall/store";
import { isProRequired } from "../features/paywall/ipc";
import { detectLocale, resolveLocale, type Locale } from "../i18n/locales";
import { describeError } from "../i18n/errors";
import { createTranslator } from "../i18n/translate";
import type { Edge } from "../features/fab/geometry";
import { loadPosition } from "../features/fab/position";
import {
  iconForUrl,
  setIconCache,
  urlsWithoutBundledIcon,
  useIconCache,
} from "../shared/siteIcons";

export type Sheet =
  | "none"
  | "assistant"
  | "history"
  | "tabs"
  | "favorites"
  | "stats"
  | "settings"
  | "recipes"
  | "incognito-recipes"
  | "more-favorites"
  | "incognito-more-favorites"
  | "library"
  | "share-recipe"
  | "paywall";

/** Pages that open on top of Settings. Closing one returns to Settings, which stays mounted beneath it. */
const SETTINGS_CHILDREN: readonly Sheet[] = [
  "recipes",
  "incognito-recipes",
  "more-favorites",
  "incognito-more-favorites",
  "library",
  "share-recipe",
  "paywall",
];
const isSettingsChild = (sheet: Sheet): boolean => SETTINGS_CHILDREN.includes(sheet);

type SheetState = Pick<AppStore, "sheet" | "sheetParent">;

/** Whether Settings is on screen, either itself or under one of its child pages. */
export const selectSettingsOpen = (store: SheetState): boolean =>
  store.sheet === "settings" || (isSettingsChild(store.sheet) && store.sheetParent === "settings");

/** What showing `next` changes: a child page opened from Settings remembers Settings as its parent. */
const showSheet = (current: SheetState, next: Sheet): SheetState => ({
  sheet: next,
  sheetParent: selectSettingsOpen(current) && isSettingsChild(next) ? "settings" : "none",
});

/** What the web layer must do natively next; `nonce` makes a repeat of the same action distinct. */
export type SessionAction = { nonce: number } & (
  | { type: "open"; id: string; url: string; previousId: string | null }
  | { type: "adopt"; id: string; url: string; previousId: null }
  | { type: "activate"; id: string }
);

export interface IncognitoState {
  active: boolean;
  /**
   * The incognito favorites. Held only while incognito is on or its Settings section is
   * unlocked, and dropped again when both end.
   */
  favorites: Favorite[];
  /** A biometric check or a switch of mode is in flight. */
  busy: boolean;
}

export interface AppStore {
  state: AppState | null;
  /** Desktop: the page sits beside the shell's controls and steps aside for its overlays. */
  desktop: boolean;
  error: string | null;
  sheet: Sheet;
  /** Where closing a child page of Settings returns to; `none` for every other sheet. */
  sheetParent: "none" | "settings";
  /** The recipe the Recipes page opens with expanded, set when a favorite sends the user there. */
  recipeFocus: string | null;
  onboardingOpen: boolean;
  sessions: Session[];
  activeId: string | null;
  /** An empty page covers the open sessions until the user opens or picks one. */
  blankTab: boolean;
  action: SessionAction | null;
  /** Edge the floating button rests on; the back button takes the other one. */
  fabEdge: Edge;
  sites: SiteSettings[];
  incognito: IncognitoState;
  /** The recipes with the incognito choices applied; filled while their Settings section is unlocked. */
  incognitoSites: SiteSettings[];
  /** Provider settings, for routing the command bar; refreshed whenever the bar opens. */
  aiState: AiState | null;
  /** The assistant's step: what the user asked, what was sent, what came back. */
  assistant: AssistantState;
  load: () => Promise<void>;
  openSheet: (sheet: Sheet) => void;
  closeSheet: () => void;
  /** An empty page with the command bar open: a new tab. The sessions stay open underneath it. */
  openNewTab: () => void;
  /** Opens the Recipes page with this recipe's card expanded. */
  openRecipe: (recipeId: string) => void;
  /** Fetches what only Settings and the fan need: site options and missing icons. Runs after the first page shows. */
  loadSecondary: () => void;
  /** Marks the guide unseen again and shows it now. */
  resetGuide: () => Promise<void>;
  finishGuide: () => Promise<void>;
  /** An address the user typed: always a new session, and remembered in history. */
  openAddress: (url: string) => void;
  /** A web search the user typed: a new session, kept out of history so queries are not listed. */
  openSearch: (url: string) => void;
  /** A site the user reached from a search: remembered in history, without opening anything. */
  recordVisit: (url: string) => void;
  /** A favorite: switches to its live session if there is one, otherwise opens a new one. */
  openFavorite: (url: string) => void;
  /** A page of a hub: switches to its live session if there is one, otherwise opens a new one. */
  openHubTab: (url: string, hubId: string) => void;
  /** A history entry: switches to the live session typed with it, otherwise opens a new one. */
  openHistory: (url: string) => void;
  /** Shows a live session by id, for example the one a notification was tapped for. */
  openSession: (id: string) => void;
  /** Ends one live session. Favorites and history are untouched; the last open site stays. */
  /** Back in the page; once it has no history of its own, the page saved from before a restart. */
  goBack: () => Promise<void>;
  closeSession: (id: string) => void;
  /** Reopens a session on the address it was opened with, dropping its Back history. Works on the only open tab too. */
  resetSession: (id: string) => void;
  /** Ends every live session but the visible one. */
  closeOtherSessions: () => void;
  setSessionState: (state: SiteViewState) => void;
  /** A native `open` failed: forget the session and go back to the one that was showing. */
  sessionOpenFailed: (id: string) => void;
  /** The native side already closed these; forget them. */
  forgetSessions: (ids: string[]) => void;
  /** Closes old, surplus or (under memory pressure) all hidden sessions. */
  trimSessions: (pressure: Pressure) => void;
  reportError: (message: string | null) => void;
  saveFavorites: (favorites: FavoriteInput[]) => Promise<boolean>;
  /** Adds a recipe's site to the favorites, or removes every favorite that opens it. */
  setSiteFavorite: (recipeId: string, favorite: boolean) => Promise<void>;
  clearHistory: () => Promise<void>;
  /** Forgets one history entry. */
  removeHistory: (url: string) => Promise<void>;
  setTheme: (theme: Theme) => Promise<void>;
  /** Picks the language the app is in; null puts it back on the device's language. */
  setLocale: (locale: string | null) => Promise<void>;
  /** Picks the engine the command bar searches with. */
  setSearchEngine: (engine: SearchEngine) => Promise<void>;
  setAdBlock: (enabled: boolean) => Promise<void>;
  /** Changes some of the accessibility choices; the rest keep their value. */
  setAccessibility: (changes: Partial<Accessibility>) => Promise<void>;
  /** Changes some of the video controls; the rest keep their value. */
  setVideoControls: (changes: Partial<VideoControls>) => Promise<void>;
  /** One site's own video controls choice; an empty one returns the site to the shared choice. */
  setSiteVideoControls: (site: string, video: SiteVideo) => Promise<void>;
  loadSites: () => Promise<void>;
  /** Re-reads the favorites after Rust changed them on its own, as the guide's quick-access pick does. */
  reloadFavorites: () => Promise<void>;
  setSiteOption: (recipeId: string, optionId: string, value: OptionValue) => Promise<void>;
  setBottomMargin: (pixels: number) => Promise<void>;
  /** `null` returns the site to the shared margin. */
  setSiteBottomMargin: (recipeId: string, pixels: number | null) => Promise<void>;
  /** Whether a site's media keeps playing while hidden or in the background. */
  setSiteBackgroundMedia: (site: string, enabled: boolean) => Promise<void>;
  /** Whether a site's videos may open in a picture-in-picture window. */
  setSitePictureInPicture: (site: string, enabled: boolean) => Promise<void>;
  setBackButton: (enabled: boolean) => Promise<void>;
  setFabEdge: (edge: Edge) => void;
  /** Shows the exact payload before it is sent; on by default. */
  setAiPreview: (enabled: boolean) => Promise<void>;
  /** Reads the provider settings the command bar needs to know whether the assistant is ready. */
  loadAi: () => Promise<void>;
  /** The text in the command bar, kept in the state so "Ask again" can hand it back. */
  editRequest: (text: string) => void;
  /** Reads the open page and builds the request; the user sees it before it is sent. */
  submitRequest: (request: string, turnId?: string) => Promise<void>;
  /** The user read the payload and pressed Send. */
  confirmSend: () => Promise<void>;
  acceptProposal: () => Promise<void>;
  rejectProposal: () => Promise<void>;
  /** Drops whatever is pending (and its page preview) and returns to the empty bar. */
  cancelAssistant: (keepText?: boolean) => void;
  retryAssistant: () => Promise<void>;
  /** Checks Face ID, Touch ID or the passcode, then switches the quick-access set to incognito. */
  enterIncognito: () => Promise<void>;
  /** Back to the normal set. No check. */
  exitIncognito: () => Promise<void>;
  /** A biometric check that changes nothing; false when cancelled or failed. */
  unlockIncognito: () => Promise<boolean>;
  /** Drops the incognito favorites an unlocked Settings section loaded, unless incognito is on. */
  forgetIncognitoFavorites: () => void;
  /** Drops the incognito recipes an unlocked Settings section loaded. */
  forgetIncognitoSites: () => void;
  loadIncognitoFavorites: () => Promise<void>;
  saveIncognitoFavorites: (favorites: FavoriteInput[]) => Promise<boolean>;
  loadIncognitoSites: () => Promise<void>;
  setIncognitoSiteOption: (recipeId: string, optionId: string, value: OptionValue) => Promise<void>;
}

function updateSite(
  sites: SiteSettings[],
  recipeId: string,
  change: (site: SiteSettings) => SiteSettings,
): SiteSettings[] {
  return sites.map((site) => (site.recipeId === recipeId ? change(site) : site));
}

function withOption(site: SiteSettings, optionId: string, value: OptionValue): SiteSettings {
  return {
    ...site,
    options: site.options.map((option) => (option.id === optionId ? { ...option, value } : option)),
  };
}

/** The page the user is looking at. */
export const selectPage = (store: AppStore): Session | null =>
  store.blankTab ? null : (store.sessions.find((session) => session.id === store.activeId) ?? null);

const NO_FAVORITES: readonly Favorite[] = [];

/** The favorites the floating button fans out: the incognito set while incognito, else the normal one. */
export const selectQuickFavorites = (store: AppStore): readonly Favorite[] =>
  store.incognito.active ? store.incognito.favorites : (store.state?.favorites ?? NO_FAVORITES);

/** The quick-access favorites the user may open right now: without Pro, the first four of them. */
export const selectUsableQuickFavorites = (store: AppStore): readonly Favorite[] =>
  usableQuickAccess(selectQuickFavorites(store), useEntitlementStore.getState().status === "pro");

/** The language the device is set to, read once: it cannot change while the app runs. */
const DEVICE_LOCALE = detectLocale();

/** The language the app is in: the one the user picked, else the device's. */
export const selectLocale = (store: AppStore): Locale =>
  resolveLocale(store.state?.locale) ?? DEVICE_LOCALE;

/** The message for something that went wrong, in the language the app is in. */
export function appError(error: unknown): string {
  if (isProRequired(error)) {
    useApp.getState().openSheet("paywall");
    return "";
  }
  return describeError(error, createTranslator(selectLocale(useApp.getState())));
}

let nonce = 0;

export const useApp = create<AppStore>((set, get) => {
  const applyIcons = () =>
    set((current) => ({
      state: current.state && {
        ...current.state,
        favorites: current.state.favorites.map((favorite) => ({
          ...favorite,
          icon: iconForUrl(favorite.url, current.state?.favorites ?? []),
        })),
      },
      incognito: {
        ...current.incognito,
        favorites: current.incognito.favorites.map((favorite) => ({
          ...favorite,
          icon: iconForUrl(favorite.url, current.incognito.favorites),
        })),
      },
    }));
  const fetchIcons = async (urls: string[]) => {
    const wanted = urlsWithoutBundledIcon(urls);
    if (wanted.length === 0) return;
    try {
      setIconCache(await library.refreshIcons(wanted));
      applyIcons();
    } catch {
      // Missing decorative icons retain their monogram.
    }
  };

  /** Takes the saved favorites, fetches missing icons, and refreshes which sites are favorited. */
  const adoptFavorites = (favorites: Favorite[]) => {
    const previous = new Set(get().state?.favorites.map((favorite) => favorite.url));
    set((current) => ({
      state: current.state && { ...current.state, favorites },
      error: null,
    }));
    get().trimSessions("routine");
    applyIcons();
    void fetchIcons(
      favorites.filter((favorite) => !previous.has(favorite.url)).map((favorite) => favorite.url),
    );
    void get().loadSites();
  };

  /** Takes the saved incognito favorites and fetches the icons they are missing. */
  const adoptIncognitoFavorites = (favorites: Favorite[]) => {
    const previous = new Set(get().incognito.favorites.map((favorite) => favorite.url));
    set((current) => ({ incognito: { ...current.incognito, favorites }, error: null }));
    get().trimSessions("routine");
    applyIcons();
    void fetchIcons(
      favorites.filter((favorite) => !previous.has(favorite.url)).map((favorite) => favorite.url),
    );
    void get().loadIncognitoSites();
  };

  const setIncognitoBusy = (busy: boolean) =>
    set((current) => ({ incognito: { ...current.incognito, busy } }));

  const translate = () => createTranslator(selectLocale(get()));

  const markUsed = (sessions: Session[], id: string | null, now: number) =>
    sessions.map((session) => (session.id === id ? { ...session, lastUsed: now } : session));

  /** A new session. `adoptedId` names a page Rust already opened at launch, which is taken over. */
  const startSession = (
    url: string,
    source: SessionSource,
    adoptedId?: string,
    hubId: string | null = null,
    restoredBack: string[] = [],
  ) => {
    const now = Date.now();
    const id = adoptedId ?? crypto.randomUUID();
    const previousId = get().activeId;
    set((current) => ({
      sessions: [
        ...markUsed(current.sessions, previousId, now),
        newSession(id, source, url, now, hubId, restoredBack),
      ],
      activeId: id,
      blankTab: false,
      sheet: "none",
      action: adoptedId
        ? { nonce: ++nonce, type: "adopt", id, url, previousId: null }
        : { nonce: ++nonce, type: "open", id, url, previousId },
    }));
    get().trimSessions("routine");
  };

  const switchTo = (id: string) => {
    const now = Date.now();
    const previousId = get().activeId;
    set((current) => ({
      sessions: markUsed(markUsed(current.sessions, previousId, now), id, now),
      activeId: id,
      blankTab: false,
      sheet: "none",
      action: { nonce: ++nonce, type: "activate", id },
    }));
    get().trimSessions("routine");
  };

  /**
   * A page the user picked from a list: the live session on that site is reused when there is
   * one, otherwise a new session opens. The page is a site of its own, so it keeps its own
   * session and its own cookies. A hub page and a favorite on the same site stay separate
   * sessions, so the Instagram favorite is Instagram and the hub's tab is its inbox.
   */
  const openPickedPage = (url: string, hubId: string | null = null) => {
    const live = findFavoriteSession(get().sessions, url, hubId);
    if (live) switchTo(live.id);
    else startSession(url, hubId ? "hub" : "favorite", undefined, hubId);
  };

  /** Incognito chats live only in memory: switching modes drops them and loads the saved ones again. */
  const resetChats = () => {
    // The open assistant turn belongs to the mode it started in: drop it before the chats go, so
    // it cannot be seen after leaving incognito or saved into the other mode's chats.
    get().cancelAssistant();
    useChat.getState().forget();
    void useChat.getState().load();
  };

  /** Applies an event, and keeps the request in the chat whenever it reached a state worth keeping. */
  const dispatch = (event: AssistantEvent) => {
    const before = get().assistant;
    set((current) => ({ assistant: assistantReducer(current.assistant, event) }));
    const after = get().assistant;
    if (after !== before) useChat.getState().keep(after);
  };

  /** Adds `url` to history (Rust skips it while incognito) and fetches its icon. */
  const recordHistory = (url: string): Promise<void> =>
    library.addHistory(url).then((history) => {
      set((current) => ({ state: current.state && { ...current.state, history } }));
      void fetchIcons([url]);
    });

  const showProPaywall = (error: unknown): boolean => {
    if (!isProRequired(error)) return false;
    dropJob(pendingJobId(get().assistant));
    dispatch({ type: "reset", keepText: true });
    get().openSheet("paywall");
    return true;
  };
  /** Rust holds a job (and the page shows its preview) until it is rejected; failures are harmless. */
  const dropJob = (id: string | null) => {
    if (id) void assistantIpc.reject(id).catch(() => {});
  };

  const runSend = async (prepared: PreparedRequest) => {
    try {
      const proposal = await assistantIpc.send(prepared.id, (step) => {
        const live = get().assistant;
        if (live.status === "sending" && live.prepared.id === prepared.id) {
          dispatch({ type: "activity", step });
        }
      });
      const current = get().assistant;
      if (current.status !== "sending" || current.prepared.id !== prepared.id) {
        dropJob(prepared.id);
        return;
      }
      dispatch({ type: "proposed", proposal });
      // Let the user see the page with the preview applied.
      if (get().assistant.status === "proposal" && get().sheet === "assistant") {
        set({ sheet: "none" });
      }
    } catch (error) {
      if (showProPaywall(error)) return;
      const current = get().assistant;
      if (current.status === "sending" && current.prepared.id === prepared.id) {
        dispatch({ type: "failed", error });
        dropJob(prepared.id);
      }
    }
  };

  return {
    state: null,
    desktop: false,
    error: null,
    sheet: "none",
    sheetParent: "none",
    recipeFocus: null,
    onboardingOpen: false,
    sessions: [],
    activeId: null,
    blankTab: false,
    action: null,
    fabEdge: loadPosition().edge,
    sites: [],
    incognito: { active: false, favorites: [], busy: false },
    incognitoSites: [],
    aiState: null,
    assistant: initialAssistant,

    load: async () => {
      try {
        const { bootSession, desktop, ...state } = await library.getState();
        void siteView.setColorScheme(state.theme).catch(() => {});
        set({ state, desktop, onboardingOpen: !state.onboarded });
        applyIcons();
        if (bootSession && !get().sessions.some((session) => session.id === bootSession.id)) {
          startSession(
            bootSession.url,
            startSource(state.favorites, bootSession.url),
            bootSession.id,
            null,
            state.lastUrl === bootSession.url ? state.lastBack : [],
          );
        }
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    loadSecondary: () => {
      void library
        .icons()
        .then((icons) => {
          useIconCache.getState().setIcons(icons);
          applyIcons();
        })
        .catch(() => {});
      void get().loadSites();
    },

    openSheet: (sheet) => {
      const isPro = useEntitlementStore.getState().status === "pro";
      set((current) => showSheet(current, !isPro && sheet === "stats" ? "paywall" : sheet));
    },
    openNewTab: () => {
      set((current) => ({ ...showSheet(current, "assistant"), blankTab: true }));
    },
    closeSheet: () =>
      set((current) => ({
        sheet: isSettingsChild(current.sheet) ? current.sheetParent : "none",
        sheetParent: "none",
        recipeFocus: null,
      })),

    openRecipe: (recipeId) => {
      get().openSheet("recipes");
      set({ recipeFocus: recipeId });
    },

    resetGuide: async () => {
      try {
        await library.resetOnboarding();
        set((current) => ({
          onboardingOpen: true,
          state: current.state && { ...current.state, onboarded: false },
        }));
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    finishGuide: async () => {
      set({ onboardingOpen: false });
      try {
        await library.completeOnboarding();
        set((current) => ({ state: current.state && { ...current.state, onboarded: true } }));
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    openAddress: (url) => {
      startSession(url, "typed");
      recordHistory(url).catch((error: unknown) => set({ error: appError(error) }));
    },

    recordVisit: (url) => void recordHistory(url).catch(() => {}),

    openSearch: (url) => startSession(url, "typed"),

    openFavorite: (url) => openPickedPage(url, hubForFavorite(get().sites, url)?.recipeId ?? null),

    openHubTab: (url, hubId) => openPickedPage(url, hubId),

    openHistory: (url) => {
      const live = findTypedSession(get().sessions, url);
      if (live) void fetchIcons([url]);
      if (live) switchTo(live.id);
      else get().openAddress(url);
    },

    openSession: (id) => {
      if (get().sessions.some((session) => session.id === id)) switchTo(id);
    },

    goBack: async () => {
      const page = selectPage(get());
      if (!page) return;
      if (page.canGoBack || page.restoredBack.length === 0) {
        await siteView.goBack();
        return;
      }
      const behind = page.restoredBack[page.restoredBack.length - 1];
      const rest = page.restoredBack.slice(0, -1);
      startSession(behind, page.source, undefined, page.hubId, rest);
      get().closeSession(page.id);
    },

    closeSession: (id) => {
      const { sessions, activeId } = get();
      if (!sessions.some((session) => session.id === id)) return;
      const next = id === activeId ? tabAfterClose(sessions, id) : activeId;
      void siteView.close(id).catch(() => {});
      set((current) => ({
        sessions: current.sessions.filter((session) => session.id !== id),
        activeId: next,
        action:
          next !== null && next !== activeId
            ? { nonce: ++nonce, type: "activate", id: next }
            : current.action,
      }));
    },

    resetSession: (id) => {
      const session = get().sessions.find((entry) => entry.id === id);
      if (!session) return;
      startSession(session.openedUrl, session.source, undefined, session.hubId);
      get().closeSession(id);
    },

    closeOtherSessions: () => {
      const { sessions, activeId } = get();
      const doomed = hiddenTabIds(sessions, activeId);
      if (doomed.length === 0) return;
      doomed.forEach((id) => void siteView.close(id).catch(() => {}));
      get().forgetSessions(doomed);
    },

    setSessionState: (page) =>
      set((current) => ({
        sessions: current.sessions.map((session) =>
          session.id === page.session ? applyState(session, page) : session,
        ),
      })),

    sessionOpenFailed: (id) =>
      set((current) => {
        const action = current.action;
        const previousId = action?.type === "open" && action.id === id ? action.previousId : null;
        const sessions = current.sessions.filter((session) => session.id !== id);
        return {
          sessions,
          activeId:
            current.activeId === id
              ? sessions.some((session) => session.id === previousId)
                ? previousId
                : (sessions[0]?.id ?? null)
              : current.activeId,
        };
      }),

    forgetSessions: (ids) =>
      set((current) => ({
        sessions: current.sessions.filter((session) => !ids.includes(session.id)),
        activeId: ids.includes(current.activeId ?? "") ? null : current.activeId,
      })),

    trimSessions: (pressure) => {
      const { sessions, activeId } = get();
      const doomed = sessionsToClose(
        sessions,
        activeId,
        Date.now(),
        pressure,
        selectUsableQuickFavorites(get()),
        get().sites,
      );
      if (doomed.length === 0) return;
      doomed.forEach((id) => void siteView.close(id).catch(() => {}));
      get().forgetSessions(doomed);
    },

    reportError: (error) => set({ error }),

    saveFavorites: async (favorites) => {
      try {
        adoptFavorites(await library.setFavorites(favorites));
        return true;
      } catch (error) {
        set({ error: appError(error) });
        return false;
      }
    },

    setSiteFavorite: async (recipeId, favorite) => {
      const before = get().sites;
      set({ sites: updateSite(before, recipeId, (site) => ({ ...site, favorite })) });
      try {
        adoptFavorites(await library.setSiteFavorite(recipeId, favorite));
      } catch (error) {
        set({ sites: before, error: appError(error) });
      }
    },

    removeHistory: async (url) => {
      try {
        const history = await library.removeHistory(url);
        set((current) => ({ state: current.state && { ...current.state, history } }));
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    clearHistory: async () => {
      try {
        await library.clearHistory();
        set((current) => ({
          state: current.state && { ...current.state, history: [], lastUrl: null },
        }));
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    setTheme: async (theme) => {
      const previous = get().state?.theme;
      set((current) => ({ state: current.state && { ...current.state, theme } }));
      try {
        await library.setTheme(theme);
        await siteView.setColorScheme(theme);
      } catch (error) {
        set((current) => ({
          state: current.state && previous ? { ...current.state, theme: previous } : current.state,
          error: appError(error),
        }));
      }
    },

    setLocale: async (locale) => {
      const previous = get().state?.locale ?? null;
      set((current) => ({ state: current.state && { ...current.state, locale } }));
      try {
        await library.setLocale(locale);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, locale: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    setSearchEngine: async (engine) => {
      const previous = get().state?.searchEngine;
      set((current) => ({ state: current.state && { ...current.state, searchEngine: engine } }));
      try {
        await library.setSearchEngine(engine);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, searchEngine: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    setAdBlock: async (enabled) => {
      const previous = get().state?.adBlock;
      set((current) => ({ state: current.state && { ...current.state, adBlock: enabled } }));
      try {
        await library.setAdBlock(enabled);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, adBlock: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    loadSites: async () => {
      try {
        set({ sites: await library.getSites(false) });
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    reloadFavorites: async () => {
      try {
        adoptFavorites((await library.getState()).favorites);
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    setSiteOption: async (recipeId, optionId, value) => {
      const before = get().sites;
      set({ sites: updateSite(before, recipeId, (site) => withOption(site, optionId, value)) });
      try {
        await library.setSiteOption(recipeId, optionId, value, false);
      } catch (error) {
        set({ sites: before, error: appError(error) });
      }
    },

    setBottomMargin: async (pixels) => {
      const previous = get().state?.bottomMargin;
      set((current) => ({
        state: current.state && { ...current.state, bottomMargin: pixels },
      }));
      try {
        await library.setBottomMargin(pixels);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, bottomMargin: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    setBackButton: async (enabled) => {
      const previous = get().state?.backButton;
      set((current) => ({ state: current.state && { ...current.state, backButton: enabled } }));
      try {
        await library.setBackButton(enabled);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, backButton: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    setAccessibility: async (changes) => {
      const previous = get().state?.accessibility;
      if (!previous) return;
      const next = { ...previous, ...changes };
      set((current) => ({ state: current.state && { ...current.state, accessibility: next } }));
      try {
        await library.setAccessibility(next);
      } catch (error) {
        set((current) => ({
          state: current.state && { ...current.state, accessibility: previous },
          error: appError(error),
        }));
      }
    },

    setVideoControls: async (changes) => {
      const previous = get().state?.videoControls;
      if (!previous) return;
      const next = { ...previous, ...changes };
      set((current) => ({ state: current.state && { ...current.state, videoControls: next } }));
      try {
        await library.setVideoControls(next);
      } catch (error) {
        set((current) => ({
          state: current.state && { ...current.state, videoControls: previous },
          error: appError(error),
        }));
      }
    },

    setSiteVideoControls: async (site, video) => {
      const previous = get().state?.videoSites;
      if (!previous) return;
      const empty = video.panel === undefined && video.height === undefined;
      const others = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== site));
      const next = empty ? others : { ...others, [site]: video };
      set((current) => ({ state: current.state && { ...current.state, videoSites: next } }));
      try {
        await library.setSiteVideoControls(site, video);
      } catch (error) {
        set((current) => ({
          state: current.state && { ...current.state, videoSites: previous },
          error: appError(error),
        }));
      }
    },

    setSiteBottomMargin: async (recipeId, pixels) => {
      const before = get().sites;
      set({ sites: updateSite(before, recipeId, (site) => ({ ...site, bottomMargin: pixels })) });
      try {
        await library.setSiteBottomMargin(recipeId, pixels);
      } catch (error) {
        set({ sites: before, error: appError(error) });
      }
    },
    setSiteBackgroundMedia: async (site, enabled) => {
      const previous = get().state?.backgroundMediaSites;
      if (!previous) return;
      const without = previous.filter((entry) => entry !== site);
      set((current) => ({
        state: current.state && {
          ...current.state,
          backgroundMediaSites: enabled ? [...without, site] : without,
        },
      }));
      try {
        await library.setSiteBackgroundMedia(site, enabled);
      } catch (error) {
        set((current) => ({
          state: current.state && { ...current.state, backgroundMediaSites: previous },
          error: appError(error),
        }));
      }
    },
    setSitePictureInPicture: async (site, enabled) => {
      const previous = get().state?.pictureInPictureSites;
      if (!previous) return;
      const without = previous.filter((entry) => entry !== site);
      set((current) => ({
        state: current.state && {
          ...current.state,
          pictureInPictureSites: enabled ? [...without, site] : without,
        },
      }));
      try {
        await library.setSitePictureInPicture(site, enabled);
      } catch (error) {
        set((current) => ({
          state: current.state && { ...current.state, pictureInPictureSites: previous },
          error: appError(error),
        }));
      }
    },
    setFabEdge: (fabEdge) => set({ fabEdge }),

    setAiPreview: async (enabled) => {
      const previous = get().state?.aiPreview;
      set((current) => ({ state: current.state && { ...current.state, aiPreview: enabled } }));
      try {
        await assistantIpc.setPreview(enabled);
      } catch (error) {
        set((current) => ({
          state:
            current.state && previous !== undefined
              ? { ...current.state, aiPreview: previous }
              : current.state,
          error: appError(error),
        }));
      }
    },

    loadAi: async () => {
      try {
        set({ aiState: await ai.state() });
      } catch {
        // routing then treats the provider as missing; Settings shows the real error
      }
    },

    editRequest: (text) => dispatch({ type: "edit", text }),

    submitRequest: async (request, turnId = crypto.randomUUID()) => {
      dispatch({ type: "submit", request, turnId });
      const started = get().assistant;
      if (started.status !== "preparing") return;
      const url = selectPage(get())?.url;
      const domain = url ? siteOf(url) : null;
      if (domain) useChat.getState().begin(domain);
      const earlier = earlierOf(selectActiveChat(useChat.getState()), turnId);
      try {
        const prepared = await assistantIpc.prepare(started.request, earlier);
        // The site Rust read from the page is the authority for which chat this is.
        useChat.getState().begin(prepared.domain);
        const current = get().assistant;
        if (current.status !== "preparing" || current.request !== started.request) {
          dropJob(prepared.id);
          return;
        }
        const preview = get().state?.aiPreview ?? true;
        dispatch({ type: "prepared", prepared, preview });
        if (!preview) await runSend(prepared);
      } catch (error) {
        if (showProPaywall(error)) return;
        const current = get().assistant;
        if (current.status === "preparing" && current.request === started.request) {
          dispatch({ type: "failed", error });
        }
      }
    },

    confirmSend: async () => {
      const current = get().assistant;
      if (current.status !== "preview") return;
      dispatch({ type: "send" });
      await runSend(current.prepared);
    },

    acceptProposal: async () => {
      const current = get().assistant;
      if (current.status !== "proposal") return;
      const id = current.proposal.id;
      dispatch({ type: "accept" });
      try {
        await assistantIpc.accept(id);
        await get().loadSites();
        dispatch({ type: "accepted" });
      } catch (error) {
        if (showProPaywall(error)) return;
        dispatch({ type: "failed", error });
      }
    },

    rejectProposal: async () => {
      const current = get().assistant;
      if (current.status !== "proposal") return;
      dispatch({ type: "reject" });
      dropJob(current.proposal.id);
    },

    cancelAssistant: (keepText) => {
      const current = get().assistant;
      dropJob(pendingJobId(current));
      if (current.status === "proposal") dispatch({ type: "reject" });
      dispatch({ type: "reset", keepText });
    },

    retryAssistant: async () => {
      const current = get().assistant;
      if (current.status !== "error") return;
      dropJob(current.jobId);
      await get().submitRequest(current.request, current.turnId);
    },

    enterIncognito: async () => {
      if (useEntitlementStore.getState().status !== "pro") {
        get().openSheet("paywall");
        return;
      }
      if (get().incognito.busy) return;
      setIncognitoBusy(true);
      try {
        const favorites = await incognitoIpc.enter(translate()("incognito.authReason"));
        if (!favorites) {
          setIncognitoBusy(false);
          return;
        }
        set({ incognito: { active: true, favorites, busy: false }, error: null });
        resetChats();
        get().trimSessions("routine");
        applyIcons();
        void fetchIcons(favorites.map((favorite) => favorite.url));
      } catch (error) {
        setIncognitoBusy(false);
        set({ error: appError(error) });
      }
    },

    exitIncognito: async () => {
      if (get().incognito.busy) return;
      setIncognitoBusy(true);
      try {
        await incognitoIpc.exit();
        set({ incognito: { active: false, favorites: [], busy: false }, incognitoSites: [] });
        resetChats();
        get().trimSessions("routine");
      } catch (error) {
        setIncognitoBusy(false);
        set({ error: appError(error) });
      }
    },

    unlockIncognito: async () => {
      if (useEntitlementStore.getState().status !== "pro") {
        get().openSheet("paywall");
        return false;
      }
      // Entering incognito already passed the check, so its own screens need no second one.
      if (get().incognito.active) return true;
      try {
        return await incognitoIpc.unlock(translate()("incognito.unlockReason"));
      } catch (error) {
        set({ error: appError(error) });
        return false;
      }
    },

    forgetIncognitoFavorites: () =>
      set((current) =>
        current.incognito.active ? current : { incognito: { ...current.incognito, favorites: [] } },
      ),

    forgetIncognitoSites: () => set({ incognitoSites: [] }),

    loadIncognitoFavorites: async () => {
      try {
        const favorites = await incognitoIpc.favorites();
        set((current) => ({ incognito: { ...current.incognito, favorites } }));
        applyIcons();
        void fetchIcons(favorites.map((favorite) => favorite.url));
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    saveIncognitoFavorites: async (favorites) => {
      try {
        adoptIncognitoFavorites(await incognitoIpc.setFavorites(favorites));
        return true;
      } catch (error) {
        set({ error: appError(error) });
        return false;
      }
    },

    loadIncognitoSites: async () => {
      try {
        set({ incognitoSites: await library.getSites(true) });
      } catch (error) {
        set({ error: appError(error) });
      }
    },

    setIncognitoSiteOption: async (recipeId, optionId, value) => {
      const before = get().incognitoSites;
      set({
        incognitoSites: updateSite(before, recipeId, (site) => withOption(site, optionId, value)),
      });
      try {
        await library.setSiteOption(recipeId, optionId, value, true);
      } catch (error) {
        set({ incognitoSites: before, error: appError(error) });
      }
    },
  };
});
