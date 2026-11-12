import { useEffect, useState, type FormEvent } from "react";
import { selectPage, selectQuickFavorites, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { displayHost, isFavoriteSite, toggleSiteFavorite } from "../../shared/favorites";
import { siteView } from "../../shared/ipc";
import {
  ArrowIcon,
  BackIcon,
  CloseIcon,
  ForwardIcon,
  ProIcon,
  ReloadIcon,
  StarIcon,
} from "../../shared/icons";
import { siteOf } from "../../shared/site";
import { ChatPane } from "../ai/ChatPane";
import { selectActiveChat, useChat } from "../ai/chatStore";
import { INPUT_MODES, MAX_REQUEST_LENGTH, routeInput, type InputMode } from "../ai/route";
import { assistant as assistantIpc, type HubProposal } from "../ai/ipc";
import { useEntitlementStore } from "../paywall/store";
import { DEFAULT_SEARCH_ENGINE } from "../../shared/searchEngines";

const primary =
  "rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-40";
const quiet =
  "rounded-full border border-hair px-4 py-2.5 text-sm font-medium text-paper/85 disabled:opacity-40";

/** Opens from the top so the keyboard never covers it. Addresses open directly; other text is a request for the assistant. */
export function CommandBar() {
  const open = useApp((s) => s.sheet === "assistant");
  const page = useApp(selectPage);
  const closeSheet = useApp((s) => s.closeSheet);
  const openAddress = useApp((s) => s.openAddress);
  const openSearch = useApp((s) => s.openSearch);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const searchEngine = useApp((s) => s.state?.searchEngine ?? DEFAULT_SEARCH_ENGINE);
  const incognito = useApp((s) => s.incognito.active);
  const favorites = useApp(selectQuickFavorites);
  const saveNormalFavorites = useApp((s) => s.saveFavorites);
  const saveIncognitoFavorites = useApp((s) => s.saveIncognitoFavorites);
  const saveFavorites = incognito ? saveIncognitoFavorites : saveNormalFavorites;
  const aiState = useApp((s) => s.aiState);
  const assistant = useApp((s) => s.assistant);
  const loadAi = useApp((s) => s.loadAi);
  const loadSites = useApp((s) => s.loadSites);
  const openSheet = useApp((s) => s.openSheet);
  const submitRequest = useApp((s) => s.submitRequest);
  const editRequest = useApp((s) => s.editRequest);
  const t = useT();
  const [notice, setNotice] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  // The mode the user picked; `null` means automatic: a site that already has a chat is a chat.
  const [modeChoice, setModeChoice] = useState<InputMode | null>(null);
  // The bar's text lives in the store, so "Ask again" can hand the request back for editing.
  const [historyOpen, setHistoryOpen] = useState(false);
  const text = assistant.status === "idle" ? assistant.draft : "";
  const assistantIdle = assistant.status === "idle";
  const sites = useApp((s) => s.sites);
  const [hubProposal, setHubProposal] = useState<HubProposal | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);
  const [hubSaved, setHubSaved] = useState<string | null>(null);
  const activeChat = useChat(selectActiveChat);
  const savedChats = useChat((s) => s.chats);
  const loadChats = useChat((s) => s.load);
  const focusChat = useChat((s) => s.focus);
  const startNewChat = useChat((s) => s.startNew);
  const pageAddress = page?.url ?? null;
  const chatDomain = pageAddress && /^https?:\/\//i.test(pageAddress) ? siteOf(pageAddress) : null;
  // A site that already has a chat opens the bar as a chat, so the next words continue it.
  const siteHasChat =
    (activeChat?.turns.length ?? 0) > 0 && activeChat?.domain === chatDomain && isPro;
  const mode: InputMode = modeChoice ?? (siteHasChat ? "chat" : "auto");
  const chatVisible = !assistantIdle || (isPro && chatDomain !== null && mode === "chat");

  useEffect(() => {
    if (open) void loadAi();
  }, [open, loadAi]);

  useEffect(() => {
    if (open && isPro) void loadChats();
  }, [open, isPro, loadChats]);

  // Reopening the bar on a site continues that site's chat, unless a request is still running.
  useEffect(() => {
    if (open && assistantIdle) focusChat(chatDomain);
  }, [open, assistantIdle, chatDomain, focusChat, savedChats]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const route = routeInput(text, {
      ai: aiState,
      pageUrl: page?.url ?? null,
      pro: isPro,
      mode,
      searchEngine,
    });
    switch (route.kind) {
      case "empty":
        setNotice(null);
        setBlocked(false);
        return;
      case "address":
        editRequest("");
        setNotice(null);
        setBlocked(false);
        openAddress(route.url);
        return;
      case "search":
        editRequest("");
        setNotice(null);
        setBlocked(false);
        openSearch(route.url);
        return;
      case "notLink":
        setNotice(t("commandBar.notLink"));
        setBlocked(false);
        return;
      case "paywall":
        setNotice(null);
        setBlocked(false);
        openSheet("paywall");
        return;
      case "blocked":
        setNotice(
          route.reason === "noProvider"
            ? t("assistant.blockedNoProvider")
            : t("assistant.blockedNoPage"),
        );
        setBlocked(route.reason === "noProvider");
        return;
      case "request":
        setNotice(null);
        setBlocked(false);
        setHubProposal(null);
        setHubError(null);
        setHubSaved(null);
        void submitRequest(route.request);
        return;
      case "hub":
        setNotice(null);
        setBlocked(false);
        setHubError(null);
        setHubSaved(null);
        setHubProposal(null);
        setHubBusy(true);
        editRequest("");
        void assistantIpc
          .buildHub(route.request)
          .then(setHubProposal)
          .catch((error: unknown) => setHubError(describeError(error, t)))
          .finally(() => setHubBusy(false));
        return;
    }
  };
  const replacingHub = hubProposal
    ? (sites.find((site) => site.recipeId === hubProposal.recipeId) ?? null)
    : null;

  const acceptHub = () => {
    if (!hubProposal) return;
    setHubBusy(true);
    setHubError(null);
    void assistantIpc
      .acceptHub(hubProposal.id)
      .then(async (saved) => {
        await loadSites();
        setHubProposal(null);
        setHubSaved(saved.name);
      })
      .catch((error: unknown) => setHubError(describeError(error, t)))
      .finally(() => setHubBusy(false));
  };

  const rejectHub = () => {
    if (!hubProposal) return;
    setHubBusy(true);
    setHubError(null);
    void assistantIpc
      .rejectHub(hubProposal.id)
      .then(() => setHubProposal(null))
      .catch((error: unknown) => setHubError(describeError(error, t)))
      .finally(() => setHubBusy(false));
  };

  const run = (action: () => Promise<void>) =>
    void action().catch((error: unknown) => setNotice(describeError(error, t)));

  // The live address, or the one the page was opened with until it reports its first state.
  const pageUrl = page?.url ?? page?.openedUrl ?? null;
  const site = pageUrl ? displayHost(pageUrl) : "";
  const favorited = pageUrl ? isFavoriteSite(favorites, pageUrl) : false;
  const starLabel = t(favorited ? "commandBar.removeFavorite" : "commandBar.addFavorite", {
    site,
  });

  const tool = "grid size-11 place-items-center rounded-full text-paper/80 disabled:opacity-25";

  return (
    <div
      data-hit={open ? "" : undefined}
      onPointerDown={closeSheet}
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
    >
      <section
        data-open={open}
        onPointerDown={(event) => event.stopPropagation()}
        className="command-bar glass absolute inset-x-3 top-[calc(var(--safe-top)+8px)] rounded-3xl p-3"
      >
        {chatVisible && (
          <div className="mb-3">
            <ChatPane
              domain={chatDomain}
              historyOpen={historyOpen}
              onToggleHistory={() => setHistoryOpen((shown) => !shown)}
              onNewChat={() => {
                startNewChat(chatDomain);
                setHistoryOpen(false);
              }}
            />
          </div>
        )}
        {assistant.status === "idle" && (
          <>
            <form onSubmit={submit} className="flex items-center gap-2">
              <input
                aria-label={t("commandBar.addressLabel")}
                autoFocus={open}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode={mode === "link" ? "url" : "search"}
                maxLength={MAX_REQUEST_LENGTH}
                enterKeyHint="go"
                placeholder={t(`commandBar.placeholder.${mode}`)}
                value={text}
                onChange={(event) => {
                  editRequest(event.target.value);
                  setNotice(null);
                  setBlocked(false);
                }}
                className="min-w-0 flex-1 bg-transparent px-2 py-2 text-base text-paper outline-none placeholder:text-paper/40"
              />
              <button type="submit" disabled={hubBusy}>
                <ArrowIcon />
              </button>
            </form>

            <div
              role="radiogroup"
              aria-label={t("commandBar.modeLabel")}
              className="mt-2 flex gap-1 px-1"
            >
              {INPUT_MODES.map((option) => {
                // Chat uses the assistant; without Pro it opens the plans.
                const locked = option === "chat" && !isPro;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={mode === option}
                    aria-disabled={locked}
                    data-testid={`commandBar.mode.${option}`}
                    onClick={() => {
                      setNotice(null);
                      setBlocked(false);
                      if (locked) openSheet("paywall");
                      else setModeChoice(option);
                    }}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium ${
                      mode === option ? "bg-accent text-on-accent" : "text-paper/70 bg-paper/[0.06]"
                    } ${locked ? "opacity-45" : ""}`}
                  >
                    {t(`commandBar.mode.${option}`)}
                    {locked && <ProIcon size={12} />}
                  </button>
                );
              })}
            </div>
            {mode === "chat" && (hubBusy || hubProposal || hubSaved || hubError) && (
              <section className="mt-3 rounded-2xl border border-hair bg-paper/[0.03] p-3">
                {hubBusy && (
                  <p role="status" className="text-sm text-paper/70">
                    {t("assistant.working")}
                  </p>
                )}
                {hubProposal && (
                  <>
                    <h2 className="text-base font-semibold text-paper">{hubProposal.name}</h2>
                    {hubProposal.summary && (
                      <p className="mt-1 text-sm text-paper/70">{hubProposal.summary}</p>
                    )}
                    {replacingHub && (
                      <p role="alert" className="mt-2 text-sm text-warning">
                        {t("library.update")}: {replacingHub.name}
                      </p>
                    )}
                    <ol className="mt-3 flex flex-col gap-2">
                      {hubProposal.tabs.map((tab) => (
                        <li
                          key={`${tab.sourceRecipeId}:${tab.url}`}
                          className="rounded-xl bg-paper/[0.04] px-3 py-2"
                        >
                          <p className="text-sm font-medium text-paper">
                            {tab.label} · {tab.host}
                          </p>
                          <p className="break-all text-xs text-paper/55">{tab.url}</p>
                          <p className="mt-1 text-xs text-paper/65">{tab.sourceRecipeName}</p>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-2 text-xs leading-snug text-paper/55">
                      {t("recipes.hubNote")}
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        className={quiet}
                        disabled={hubBusy}
                        onClick={rejectHub}
                      >
                        {t("assistant.reject")}
                      </button>
                      <button
                        type="button"
                        className={primary}
                        disabled={hubBusy}
                        onClick={acceptHub}
                      >
                        {t(replacingHub ? "library.update" : "assistant.accept")}
                      </button>
                    </div>
                  </>
                )}
                {hubSaved && !hubProposal && (
                  <div className="flex items-center justify-between gap-2">
                    <p role="status" className="text-sm text-paper">
                      {t("library.added")}: {hubSaved}
                    </p>
                    <button type="button" className={quiet} onClick={() => openSheet("share")}>
                      {t("library.shareRecipe")}
                    </button>
                  </div>
                )}
                {hubError && (
                  <p role="alert" className="mt-2 text-sm text-error">
                    {hubError}
                  </p>
                )}
              </section>
            )}

            <p className="min-h-4 px-2 pt-1 text-xs leading-snug text-paper/55">
              {notice ?? (page?.url ? new URL(page.url).host : "")}
              {blocked && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => openSheet("settings")}
                    className="font-medium text-accent"
                  >
                    {t("commandBar.openAiSettings")}
                  </button>
                </>
              )}
            </p>
          </>
        )}

        <div className="mt-2 flex items-center justify-between border-t border-hair pt-2">
          <div className="flex">
            <button
              type="button"
              aria-label={t("common.back")}
              disabled={!page?.canGoBack}
              className={tool}
              onClick={() => run(siteView.goBack)}
            >
              <BackIcon />
            </button>
            <button
              type="button"
              aria-label={t("commandBar.forward")}
              disabled={!page?.canGoForward}
              className={tool}
              onClick={() => run(siteView.goForward)}
            >
              <ForwardIcon />
            </button>
            <button
              type="button"
              aria-label={t("commandBar.reload")}
              className={tool}
              onClick={() => run(siteView.reload)}
            >
              <ReloadIcon />
            </button>
          </div>
          <div className="flex items-center">
            <button
              type="button"
              aria-pressed={favorited}
              aria-label={starLabel}
              disabled={!pageUrl}
              className={`${tool} ${favorited ? "text-accent" : ""}`}
              onClick={() => {
                if (!pageUrl) return;
                void saveFavorites(toggleSiteFavorite(favorites, pageUrl));
              }}
            >
              <StarIcon filled={favorited} />
            </button>
            <button
              type="button"
              aria-label={t("commandBar.close")}
              className={tool}
              onClick={closeSheet}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
