import { useState } from "react";
import { appError, useApp } from "../../app/store";
import { describeError } from "../../i18n/errors";
import { useT } from "../../i18n/useT";
import { ProIcon } from "../../shared/icons";
import { Screen } from "../../shared/Screen";
import { useEntitlementStore } from "../paywall/store";
import { Group, GroupLabel, field, primaryButton, quietButton } from "../settings/ui";
import { sharing, type RecipePreview } from "./ipc";
import { RecipeReview } from "./RecipeReview";

/** Moves recipes between devices as text. Opened from Settings. */
export function ShareScreen() {
  const open = useApp((s) => s.sheet === "share");
  return open ? <ShareBody /> : null;
}

function ShareBody() {
  const closeSheet = useApp((s) => s.closeSheet);
  const t = useT();

  return (
    <Screen title={t("share.link")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <div className="flex flex-col gap-8">
        <ImportSection />
        <ExportSection />
      </div>
    </Screen>
  );
}

function ImportSection() {
  const loadSites = useApp((s) => s.loadSites);
  const t = useT();
  const [text, setText] = useState("");
  const [previews, setPreviews] = useState<RecipePreview[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const edit = (next: string) => {
    setText(next);
    setPreviews(null);
    setDone(false);
    setError(null);
  };

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      const found = await sharing.previewImport(text);
      setPreviews(found);
      setChosen(new Set(found.map((preview) => preview.id)));
    } catch (failure) {
      setPreviews(null);
      setError(describeError(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharing.importRecipes(text, [...chosen]);
      await loadSites();
      setText("");
      setPreviews(null);
      setDone(true);
    } catch (failure) {
      setError(describeError(failure, t));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="flex flex-col gap-4">
      <div>
        <GroupLabel>{t("share.import")}</GroupLabel>
        <p className="px-1 text-[13px] leading-snug text-paper/50">{t("share.importNote")}</p>
      </div>
      <textarea
        value={text}
        onChange={(event) => edit(event.target.value)}
        placeholder={t("share.paste")}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className={`${field} min-h-32 font-mono text-sm`}
      />
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {done && <p className="px-1 text-sm text-paper/70">{t("library.added")}</p>}
      {previews === null && (
        <button
          type="button"
          disabled={busy || text.trim().length === 0}
          onClick={() => void review()}
          className={`self-start ${primaryButton}`}
        >
          {t("share.review")}
        </button>
      )}
      {previews?.map((preview) => (
        <details key={preview.id} className="rounded-2xl border border-hair bg-paper/[0.04]">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5">
            <input
              type="checkbox"
              checked={chosen.has(preview.id)}
              onChange={() => toggle(preview.id)}
              onClick={(event) => event.stopPropagation()}
              aria-label={preview.name}
              className="size-5 accent-[var(--color-accent)]"
            />
            <span className="min-w-0 flex-1 truncate text-base font-medium">{preview.name}</span>
          </summary>
          <div className="border-t border-hair px-3 py-4">
            <RecipeReview preview={preview} />
          </div>
        </details>
      ))}
      {previews !== null && (
        <button
          type="button"
          disabled={busy || chosen.size === 0}
          onClick={() => void add()}
          className={`self-start ${primaryButton}`}
        >
          {t("share.addSelected")}
        </button>
      )}
    </section>
  );
}

function ExportSection() {
  const sites = useApp((s) => s.sites);
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [exported, setExported] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setExported(null);
    setCopied(false);
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const copy = async () => {
    if (!isPro) {
      openSheet("paywall");
      return;
    }
    setError(null);
    setCopied(false);
    try {
      const text = await sharing.exportRecipes([...chosen]);
      setExported(text);
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      } catch {
        setError(t("share.copyFailed"));
      }
    } catch (failure) {
      // Rust refuses a non-Pro export with the code that opens the paywall.
      setError(appError(failure));
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <div>
        <GroupLabel>
          <span className="flex items-center gap-2">
            {t("share.export")}
            {!isPro && <ProIcon size={14} />}
          </span>
        </GroupLabel>
        <p className="px-1 text-[13px] leading-snug text-paper/50">{t("share.exportNote")}</p>
      </div>
      {sites.length === 0 ? (
        <p className="px-1 text-sm text-paper/55">{t("share.none")}</p>
      ) : (
        <Group>
          {sites.map((site) => (
            <label
              key={site.recipeId}
              className="flex items-center gap-3 px-4 py-3.5 active:bg-paper/[0.05]"
            >
              <input
                type="checkbox"
                checked={chosen.has(site.recipeId)}
                onChange={() => toggle(site.recipeId)}
                className="size-5 accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-base">{site.name}</span>
            </label>
          ))}
        </Group>
      )}
      {sites.length > 0 && (
        <button
          type="button"
          disabled={chosen.size === 0}
          onClick={() => void copy()}
          className={`flex items-center gap-2 self-start ${quietButton}`}
        >
          {!isPro && <ProIcon size={14} />}
          {copied ? t("share.copied") : t("share.copy")}
        </button>
      )}
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {exported && (
        <textarea
          readOnly
          value={exported}
          onFocus={(event) => event.currentTarget.select()}
          className={`${field} min-h-32 font-mono text-sm`}
        />
      )}
    </section>
  );
}
