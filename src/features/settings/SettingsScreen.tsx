import { useEffect, useState } from "react";
import { selectSettingsOpen, useApp } from "../../app/store";
import { LOCALES_BY_NAME } from "../../i18n/locales";
import type { MessageKey } from "../../i18n/messages";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { useChat } from "../ai/chatStore";
import { Screen } from "../../shared/Screen";
import type { SearchEngine, Theme } from "../../shared/ipc";
import { DEFAULT_SEARCH_ENGINE, SEARCH_ENGINES } from "../../shared/searchEngines";
import { AccessibilitySection } from "./AccessibilitySection";
import { DarkModeLink } from "./DarkModeScreen";
import { VideoControlsLink } from "./VideoControlsScreen";
import { AiSection } from "./AiSection";
import { FavoritesSection } from "./FavoritesSection";
import { IncognitoFavoritesSection, IncognitoRecipesLink } from "./IncognitoSections";
import { LibraryLinks } from "../library/Links";
import { RecipesLink } from "./RecipesScreen";
import { Switch } from "./Switch";
import { UpdatesSection } from "./UpdatesSection";
import { Picker } from "./Picker";
import { NavRow } from "./SiteParts";
import { Group, Section, primaryButton, quietButton } from "./ui";

export function SettingsScreen() {
  const open = useApp(selectSettingsOpen);
  const incognitoChildOpen = useApp(
    (s) => s.sheet === "incognito-recipes" || s.sheet === "incognito-more-favorites",
  );
  const closeSheet = useApp((s) => s.closeSheet);
  const t = useT();
  if (!open) return null;

  return (
    <Screen title={t("settings.title")} closeLabel={t("settings.close")} onClose={closeSheet}>
      <div className="flex flex-col gap-9">
        <AppearanceSection />
        <LanguageSection />
        <BrowsingSection />
        <AccessibilitySection />
        <DarkModeLink />
        <VideoControlsLink />
        <FanButtonSwitches />
        <DownloadsLink />
        <ImportLinks />
        <FavoritesSection />
        <RecipesLink />
        <LibraryLinks />
        <IncognitoFavoritesSection key={incognitoChildOpen ? "incognito-child" : "settings"} />
        <IncognitoRecipesLink />
        <AiSection />
        <UpdatesSection />
        <DataSection />
      </div>
    </Screen>
  );
}

/**
 * Turns the optional buttons on the floating button's fan on or off. Both are off until chosen.
 * Desktop has no page to read, so no switches there.
 */
function FanButtonSwitches() {
  const desktop = useApp((s) => s.desktop);
  const colorPicker = useApp((s) => s.state?.colorPicker ?? false);
  const techDetector = useApp((s) => s.state?.techDetector ?? false);
  const setColorPicker = useApp((s) => s.setColorPicker);
  const setTechDetector = useApp((s) => s.setTechDetector);
  const t = useT();
  if (desktop) return null;

  return (
    <Group>
      <Switch
        label={t("settings.colorPicker")}
        description={t("settings.colorPickerNote")}
        checked={colorPicker}
        onChange={(on) => void setColorPicker(on)}
      />
      <Switch
        label={t("settings.techDetector")}
        description={t("settings.techDetectorNote")}
        checked={techDetector}
        onChange={(on) => void setTechDetector(on)}
      />
    </Group>
  );
}

/** The rows that open the import page and the saved passwords. */
function ImportLinks() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <NavRow
        title={t("settings.import")}
        note={t("settings.importNote")}
        onClick={() => openSheet("import")}
      />
      <NavRow
        title={t("settings.passwords")}
        note={t("settings.passwordsNote")}
        onClick={() => openSheet("passwords")}
      />
    </Group>
  );
}

/** The row that opens the downloads page: the list, the page's media, the folder, the names and the rules. */
function DownloadsLink() {
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  return (
    <Group>
      <NavRow
        title={t("settings.downloads")}
        note={t("settings.downloadsNote")}
        onClick={() => openSheet("downloads")}
      />
    </Group>
  );
}

const THEMES: { value: Theme; label: MessageKey }[] = [
  { value: "system", label: "settings.themeSystem" },
  { value: "light", label: "settings.themeLight" },
  { value: "dark", label: "settings.themeDark" },
];

function AppearanceSection() {
  const theme = useApp((s) => s.state?.theme ?? "system");
  const setTheme = useApp((s) => s.setTheme);
  const t = useT();

  return (
    <Section title={t("settings.appearance")} note={t("settings.appearanceNote")}>
      <div
        role="radiogroup"
        aria-label={t("settings.themeLabel")}
        className="grid grid-cols-3 gap-1 rounded-2xl border border-hair bg-paper/[0.04] p-1"
      >
        {THEMES.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={theme === option.value}
            onClick={() => void setTheme(option.value)}
            className={`rounded-xl py-2.5 text-sm font-medium ${
              theme === option.value ? "bg-accent text-on-accent" : "text-paper/75"
            }`}
          >
            {t(option.label)}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** The language of the app's text. An empty choice means the device's own language. */
function LanguageSection() {
  const locale = useApp((s) => s.state?.locale ?? null);
  const setLocale = useApp((s) => s.setLocale);
  const t = useT();

  return (
    <Section title={t("settings.language")} note={t("settings.languageNote")}>
      <Group>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <div className="text-xs text-paper/60">{t("settings.languageLabel")}</div>
          <Picker
            label={t("settings.languageLabel")}
            value={locale ?? ""}
            options={[
              { value: "", label: t("settings.languageSystem") },
              ...LOCALES_BY_NAME.map((entry) => ({ value: entry.tag, label: entry.nativeName })),
            ]}
            onChange={(next) => void setLocale(next || null)}
          />
        </div>
      </Group>
    </Section>
  );
}

function BrowsingSection() {
  const adBlock = useApp((s) => s.state?.adBlock ?? true);
  const searchEngine = useApp((s) => s.state?.searchEngine ?? DEFAULT_SEARCH_ENGINE);
  const blockPopups = useApp((s) => s.state?.blockPopups ?? true);
  const setAdBlock = useApp((s) => s.setAdBlock);
  const setBlockPopups = useApp((s) => s.setBlockPopups);
  const setSearchEngine = useApp((s) => s.setSearchEngine);
  const t = useT();

  return (
    <Section title={t("settings.browsing")} note={t("settings.browsingNote")}>
      <Group>
        <Switch
          label={t("settings.adBlock")}
          checked={adBlock}
          onChange={(on) => void setAdBlock(on)}
        />
        <div className="ps-6">
          <Switch
            label={t("settings.blockPopups")}
            description={t("settings.blockPopupsNote")}
            checked={blockPopups}
            disabled={!adBlock}
            onChange={(on) => void setBlockPopups(on)}
          />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <div className="text-xs text-paper/60">{t("settings.searchEngine")}</div>
          <Picker
            label={t("settings.searchEngine")}
            value={searchEngine}
            options={SEARCH_ENGINES.map((engine) => ({ value: engine.id, label: engine.name }))}
            onChange={(next) => void setSearchEngine(next as SearchEngine)}
          />
        </div>
      </Group>
    </Section>
  );
}

function DataSection() {
  const count = useApp((s) => s.state?.history.length ?? 0);
  const clearHistory = useApp((s) => s.clearHistory);
  const resetGuide = useApp((s) => s.resetGuide);
  const [confirming, setConfirming] = useState(false);
  const t = useT();

  return (
    <Section title={t("settings.data")} note={t("settings.dataNote")}>
      <Group>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-base">{t("settings.history")}</div>
            <div className="text-sm text-paper/55">
              {count === 0 ? t("settings.historyEmpty") : t("settings.historyCount", { count })}
            </div>
          </div>
          {confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => setConfirming(false)} className={quietButton}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  void clearHistory();
                }}
                className={primaryButton}
              >
                {t("common.clear")}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={count === 0}
              onClick={() => setConfirming(true)}
              className={quietButton}
            >
              {t("common.clear")}
            </button>
          )}
        </div>
        <ChatHistoryRow />
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-base">{t("settings.guide")}</div>
            <div className="text-sm text-paper/55">{t("settings.guideNote")}</div>
          </div>
          <button type="button" onClick={() => void resetGuide()} className={quietButton}>
            {t("settings.replay")}
          </button>
        </div>
      </Group>
    </Section>
  );
}

/** Saved assistant chats: how many there are, and one button to erase them all. */
function ChatHistoryRow() {
  const count = useChat((s) => s.chats.filter((chat) => chat.turns.length > 0).length);
  const load = useChat((s) => s.load);
  const clear = useChat((s) => s.clear);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    void load();
  }, [load]);

  const erase = () => {
    setConfirming(false);
    clear().then(
      () => setFailure(null),
      (error: unknown) => setFailure(describeError(error, t)),
    );
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-base">{t("settings.chats")}</div>
        <div className="text-sm text-paper/55">
          {failure ??
            (count === 0 ? t("settings.chatsEmpty") : t("settings.chatsCount", { count }))}
        </div>
        <div className="mt-0.5 text-xs leading-snug text-paper/45">{t("settings.chatsNote")}</div>
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={() => setConfirming(false)} className={quietButton}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={erase} className={primaryButton}>
            {t("common.clear")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={count === 0}
          onClick={() => setConfirming(true)}
          className={quietButton}
        >
          {t("common.clear")}
        </button>
      )}
    </div>
  );
}
