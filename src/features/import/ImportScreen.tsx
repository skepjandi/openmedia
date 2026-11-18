import { useRef, useState } from "react";
import { useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { importer, type ImportPreview, type ImportResult } from "../../shared/ipc";
import { SEARCH_ENGINES } from "../../shared/searchEngines";
import { Switch } from "../settings/Switch";
import { Group, GroupLabel, primaryBlockButton, quietBlockButton } from "../settings/ui";

/** The largest file the shell reads; Rust refuses more than this as well. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Matches `FREE_FAVORITE_LIMIT` and `PRO_FAVORITE_LIMIT` in Rust; only for the note's wording. */
const FAVORITE_SLOTS = 5;

interface Picks {
  recipes: Set<string>;
  sites: Set<string>;
  history: boolean;
  searchEngine: boolean;
  passwords: boolean;
}

function defaultPicks(preview: ImportPreview): Picks {
  return {
    recipes: new Set(preview.recipes.map((recipe) => recipe.recipeId)),
    sites: new Set(),
    history: preview.history + preview.bookmarks > 0,
    searchEngine: preview.searchEngine !== null,
    passwords: preview.passwords > 0,
  };
}

const toggled = (set: Set<string>, value: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(value);
  else next.delete(value);
  return next;
};

/** Settings > Import from another browser: choose exported files, tick what to bring in. */
export function ImportScreen() {
  const open = useApp((s) => s.sheet === "import");
  const closeSheet = useApp((s) => s.closeSheet);
  const load = useApp((s) => s.load);
  const loadSites = useApp((s) => s.loadSites);
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Picks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  if (!open) return null;

  const close = () => {
    void importer.cancel().catch(() => {});
    setPreview(null);
    setPicks(null);
    setError(null);
    setResult(null);
    closeSheet();
  };

  const readFiles = async (files: FileList) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      let latest: ImportPreview | null = null;
      for (const file of Array.from(files)) {
        if (file.size > MAX_FILE_BYTES) throw new Error(t("import.tooLarge", { name: file.name }));
        latest = await importer.read(await file.text());
      }
      if (latest) {
        setPreview(latest);
        setPicks((now) => now ?? defaultPicks(latest));
      }
    } catch (failure) {
      setError(describeError(failure instanceof Error ? failure.message : failure, t));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const apply = async () => {
    if (!picks) return;
    setBusy(true);
    setError(null);
    try {
      const done = await importer.apply({
        recipes: [...picks.recipes],
        sites: [...picks.sites],
        history: picks.history,
        searchEngine: picks.searchEngine,
        passwords: picks.passwords,
      });
      setResult(done);
      setPreview(null);
      setPicks(null);
      await Promise.all([load(), loadSites()]);
    } catch (failure) {
      setError(describeError(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const nothingFound =
    preview !== null &&
    preview.bookmarks + preview.history + preview.passwords === 0 &&
    preview.searchEngine === null;
  const engine = preview?.searchEngine
    ? SEARCH_ENGINES.find((entry) => entry.id === preview.searchEngine)?.name
    : undefined;

  return (
    <Screen title={t("import.title")} closeLabel={t("common.back")} onClose={close} back>
      <div className="flex flex-col gap-6">
        <p className="text-sm leading-snug text-paper/65">{t("import.intro")}</p>
        <input
          ref={input}
          type="file"
          multiple
          accept=".html,.htm,.json,.csv,.txt,text/html,application/json,text/csv,text/plain"
          className="hidden"
          onChange={(event) => event.target.files && void readFiles(event.target.files)}
        />
        <button
          type="button"
          disabled={busy}
          className={quietBlockButton}
          onClick={() => input.current?.click()}
        >
          {t(busy ? "import.reading" : preview ? "import.chooseMore" : "import.choose")}
        </button>
        {error && (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        )}
        {nothingFound && <p className="text-sm text-paper/65">{t("import.nothing")}</p>}
        {result && (
          <p role="status" className="text-sm text-paper/85">
            {t("import.done", {
              recipes: result.recipes,
              favorites: result.favorites,
              history: result.history,
              passwords: result.passwords,
            })}
          </p>
        )}
        {preview && picks && !nothingFound && (
          <>
            <p className="text-sm text-paper/65">
              {t("import.found", {
                bookmarks: preview.bookmarks,
                history: preview.history,
                passwords: preview.passwords,
              })}
            </p>
            {preview.recipes.length > 0 && (
              <div className="flex flex-col gap-2">
                <GroupLabel>{t("import.recipes")}</GroupLabel>
                <Group>
                  {preview.recipes.map((recipe) => (
                    <Switch
                      key={recipe.recipeId}
                      label={recipe.name}
                      description={recipe.site}
                      checked={picks.recipes.has(recipe.recipeId)}
                      onChange={(on) =>
                        setPicks({ ...picks, recipes: toggled(picks.recipes, recipe.recipeId, on) })
                      }
                    />
                  ))}
                </Group>
              </div>
            )}
            {preview.sites.length > 0 && (
              <div className="flex flex-col gap-2">
                <GroupLabel>{t("import.sites")}</GroupLabel>
                <Group>
                  {preview.sites.map((site) => (
                    <Switch
                      key={site.site}
                      label={site.name}
                      description={site.site}
                      checked={picks.sites.has(site.site)}
                      onChange={(on) =>
                        setPicks({ ...picks, sites: toggled(picks.sites, site.site, on) })
                      }
                    />
                  ))}
                </Group>
                <p className="px-1 text-xs text-paper/55">
                  {t("import.limitNote", { limit: FAVORITE_SLOTS })}
                </p>
              </div>
            )}
            <Group>
              {preview.history + preview.bookmarks > 0 && (
                <Switch
                  label={t("import.history", {
                    count: Math.min(100, preview.history || preview.bookmarks),
                  })}
                  checked={picks.history}
                  onChange={(on) => setPicks({ ...picks, history: on })}
                />
              )}
              {engine && (
                <Switch
                  label={t("import.searchEngine", { engine })}
                  checked={picks.searchEngine}
                  onChange={(on) => setPicks({ ...picks, searchEngine: on })}
                />
              )}
              {preview.passwords > 0 && (
                <Switch
                  label={t("import.passwords", { count: preview.passwords })}
                  description={t("import.passwordsNote")}
                  checked={picks.passwords}
                  onChange={(on) => setPicks({ ...picks, passwords: on })}
                />
              )}
            </Group>
            <button
              type="button"
              disabled={busy}
              className={primaryBlockButton}
              onClick={() => void apply()}
            >
              {t("import.apply")}
            </button>
          </>
        )}
      </div>
    </Screen>
  );
}
