import { useCallback, useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import type { Translate } from "../../i18n/translate";
import { useT } from "../../i18n/useT";
import { ForwardIcon, LockIcon, PlusIcon } from "../../shared/icons";
import { ai, type AiState, type Provider, type ProviderKind } from "../../shared/ipc";
import { Picker } from "./Picker";
import { PRESETS } from "./presets";
import { Switch } from "./Switch";
import { Group, Section, field, quietButton } from "./ui";
import { useEntitlementStore } from "../paywall/store";

interface Draft {
  id?: string;
  presetId: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}

const blankDraft = (): Draft => ({
  presetId: PRESETS[0].id,
  name: PRESETS[0].label,
  kind: PRESETS[0].kind,
  baseUrl: PRESETS[0].baseUrl,
  model: "",
  hasKey: false,
});

const draftOf = (p: Provider): Draft => ({
  id: p.id,
  presetId: PRESETS.find((x) => x.baseUrl === p.baseUrl)?.id ?? "custom",
  name: p.name,
  kind: p.kind,
  baseUrl: p.baseUrl,
  model: p.model ?? "",
  hasKey: p.hasKey,
});

/** What the command bar can do right now, in the user's words. */
function connectionLine(state: AiState | null, t: Translate): string {
  if (!state || state.providers.length === 0) return t("ai.noProviderYet");
  const active = state.providers.find((p) => p.id === state.activeId);
  if (!active) return t("ai.noProviderActive");
  if (!active.hasKey) return t("ai.providerNoKey", { name: active.name });
  const model = active.model ? ` (${active.model})` : "";
  return t("ai.providerReady", { name: active.name, model });
}

/** Bring-your-own-key providers. Keys go to Rust and the Keychain and never come back. */
export function AiSection() {
  const [state, setState] = useState<AiState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const reload = useCallback(async () => {
    try {
      setState(await ai.state());
    } catch (e) {
      setError(appError(e));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    ai.state().then(
      (loaded) => !cancelled && setState(loaded),
      (e: unknown) => !cancelled && setError(appError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const makeActive = async (id: string) => {
    await ai.setActive(id).catch((e: unknown) => setError(appError(e)));
    await reload();
  };

  const preview = useApp((s) => s.state?.aiPreview ?? true);
  const setAiPreview = useApp((s) => s.setAiPreview);
  const openSheet = useApp((state) => state.openSheet);
  const isPro = useEntitlementStore((state) => state.status === "pro");

  return (
    <Section title={t("ai.title")} note={t("ai.note")}>
      <p className="px-1 pb-2 text-[13px] leading-snug text-paper/60">{connectionLine(state, t)}</p>
      {!isPro && (
        <button
          type="button"
          onClick={() => openSheet("paywall")}
          className="mb-3 flex w-full items-center gap-3 rounded-2xl border border-hair bg-paper/[0.04] px-4 py-3.5 text-start active:bg-paper/[0.08]"
        >
          <span className="pro-badge grid size-9 shrink-0 place-items-center rounded-full">
            <LockIcon size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium">{t("paywall.title")}</span>
            <span className="block text-sm leading-snug text-paper/55">
              {t("paywall.subtitle")}
            </span>
          </span>
          <span aria-hidden="true" className="text-paper/50 rtl:-scale-x-100">
            <ForwardIcon />
          </span>
        </button>
      )}
      {state && state.providers.length > 0 && (
        <Group>
          {state.providers.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-4 py-3">
              {isPro ? (
                <>
                  <button
                    type="button"
                    aria-label={t("ai.use", { name: p.name })}
                    aria-pressed={state.activeId === p.id}
                    onClick={() => void makeActive(p.id)}
                    className={`grid size-5 shrink-0 place-items-center rounded-full border ${state.activeId === p.id ? "border-accent" : "border-paper/30"}`}
                  >
                    {state.activeId === p.id && (
                      <span className="size-2.5 rounded-full bg-accent" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium">{p.name}</div>
                    <div className="truncate text-sm text-paper/55">
                      {p.hasKey ? t("ai.keySaved") : t("ai.noKey")}
                      {p.model ? ` · ${p.model}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() => setDraft(draftOf(p))}
                  >
                    {t("common.edit")}
                  </button>
                </>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-medium">{p.name}</div>
                    <div className="truncate text-sm text-paper/55">
                      {p.hasKey ? t("ai.keySaved") : t("ai.noKey")}
                    </div>
                  </div>
                  {p.hasKey && (
                    <button
                      type="button"
                      className={quietButton}
                      onClick={() =>
                        void ai
                          .removeKey(p.id)
                          .then(reload)
                          .catch((e: unknown) => setError(appError(e)))
                      }
                    >
                      {t("common.remove")}
                    </button>
                  )}
                  <button
                    type="button"
                    className={quietButton}
                    onClick={() =>
                      void ai
                        .deleteProvider(p.id)
                        .then(reload)
                        .catch((e: unknown) => setError(appError(e)))
                    }
                  >
                    {t("common.delete")}
                  </button>
                </>
              )}
            </div>
          ))}
        </Group>
      )}

      {isPro &&
        (draft ? (
          <ProviderForm
            key={draft.id ?? "new"}
            initial={draft}
            onClose={() => setDraft(null)}
            onChanged={reload}
          />
        ) : (
          <button
            type="button"
            onClick={() => setDraft(blankDraft())}
            className="mt-3 flex items-center gap-2 px-1 py-1 text-sm font-medium text-accent"
          >
            <PlusIcon /> {t("ai.addProvider")}
          </button>
        ))}
      {error && !draft && <p className="mt-2 px-1 text-sm text-accent">{error}</p>}

      {isPro && (
        <Group>
          <Switch
            label={t("ai.previewToggle")}
            description={t("ai.previewNote")}
            checked={preview}
            onChange={(on) => void setAiPreview(on)}
          />
        </Group>
      )}

      <details className="mt-4 rounded-2xl border border-hair bg-paper/[0.04] px-4 py-3 text-sm text-paper/70">
        <summary className="cursor-pointer font-medium text-paper">{t("ai.whereToGetKey")}</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 ps-5">
          <li>{t("ai.openrouter")}</li>
          <li>{t("ai.opencode")}</li>
          <li>{t("ai.local")}</li>
        </ul>
        <p className="mt-2 text-xs text-paper/50">{t("ai.pricingNote")}</p>
      </details>
    </Section>
  );
}

interface FormProps {
  initial: Draft;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

function ProviderForm({ initial, onClose, onChanged }: FormProps) {
  const [draft, setDraft] = useState(initial);
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [replacing, setReplacing] = useState(!initial.hasKey);
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = useT();

  const patch = (change: Partial<Draft>) => {
    setNote(null);
    setDraft((d) => ({ ...d, ...change }));
  };

  const choosePreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset)
      patch({ presetId: id, name: preset.label, kind: preset.kind, baseUrl: preset.baseUrl });
  };

  /** Saves the settings, then the key if one was typed; returns the provider id. */
  const persist = async (): Promise<string> => {
    const saved = await ai.saveProvider({
      id: draft.id,
      name: draft.name,
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      model: draft.model || null,
    });
    if (key) {
      await ai.setKey(saved.id, key);
      setKey("");
      setReplacing(false);
      setDraft((d) => ({ ...d, id: saved.id, hasKey: true }));
    } else {
      setDraft((d) => ({ ...d, id: saved.id }));
    }
    await onChanged();
    return saved.id;
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setNote(appError(e));
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    run(async () => {
      const id = await persist();
      const found = await ai.test(id);
      setModels(found);
      setNote(t("ai.connected", { count: found.length }));
    });

  const save = () =>
    run(async () => {
      await persist();
      onClose();
    });

  const remove = () =>
    run(async () => {
      if (!draft.id) return;
      await ai.deleteProvider(draft.id);
      await onChanged();
      onClose();
    });

  const removeKey = () =>
    run(async () => {
      if (!draft.id) return;
      await ai.removeKey(draft.id);
      setDraft((d) => ({ ...d, hasKey: false }));
      setReplacing(true);
      await onChanged();
    });

  const preset = PRESETS.find((p) => p.id === draft.presetId);

  return (
    <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-hair bg-paper/[0.04] p-4">
      {!initial.id && (
        <Picker
          label={t("ai.providerLabel")}
          value={draft.presetId}
          options={PRESETS.map((p) => ({
            value: p.id,
            label: p.labelKey ? t(p.labelKey) : p.label,
          }))}
          onChange={choosePreset}
        />
      )}
      <input
        aria-label={t("ai.providerName")}
        className={field}
        placeholder={t("ai.namePlaceholder")}
        maxLength={30}
        value={draft.name}
        onChange={(e) => patch({ name: e.target.value })}
      />
      <input
        aria-label={t("ai.baseUrl")}
        className={field}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        placeholder={preset?.placeholder ?? "https://…"}
        value={draft.baseUrl}
        onChange={(e) => patch({ baseUrl: e.target.value })}
      />

      {replacing ? (
        <div className="flex items-center gap-2">
          <input
            aria-label={t("ai.apiKey")}
            className={field}
            type={showKey ? "text" : "password"}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("ai.apiKey")}
            value={key}
            onChange={(e) => {
              setNote(null);
              setKey(e.target.value);
            }}
          />
          <button type="button" className={quietButton} onClick={() => setShowKey((v) => !v)}>
            {showKey ? t("ai.hide") : t("ai.show")}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-sm text-paper/70">
          <span>{t("ai.keyInKeychain")}</span>
          <span className="flex gap-2">
            <button type="button" className={quietButton} onClick={() => setReplacing(true)}>
              {t("ai.replace")}
            </button>
            <button
              type="button"
              className={quietButton}
              disabled={busy}
              onClick={() => void removeKey()}
            >
              {t("common.remove")}
            </button>
          </span>
        </div>
      )}

      {models.length > 0 ? (
        <Picker
          label={t("ai.model")}
          value={draft.model}
          options={[
            { value: "", label: t("ai.chooseModel") },
            ...models.map((m) => ({ value: m, label: m })),
          ]}
          onChange={(model) => patch({ model })}
        />
      ) : (
        <input
          aria-label={t("ai.model")}
          className={field}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={t("ai.modelPlaceholder")}
          value={draft.model}
          onChange={(e) => patch({ model: e.target.value })}
        />
      )}

      {note && <p className="text-sm text-accent">{note}</p>}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={quietButton} disabled={busy} onClick={() => void test()}>
          {t("ai.testConnection")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-on-accent"
        >
          {t("common.save")}
        </button>
        <button type="button" className={quietButton} onClick={onClose}>
          {t("common.cancel")}
        </button>
        {draft.id && (
          <button
            type="button"
            className={`${quietButton} ms-auto text-red-400`}
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("common.delete")}
          </button>
        )}
      </div>
    </div>
  );
}
