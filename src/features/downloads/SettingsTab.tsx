import { useState } from "react";
import { useT } from "../../i18n/useT";
import type { DownloadKind, DownloadRule, DownloadSettings } from "../../shared/ipc";
import { Segmented } from "../settings/Segmented";
import { Switch } from "../settings/Switch";
import {
  Group,
  Section,
  dangerButton,
  field,
  primaryBlockButton,
  quietButton,
} from "../settings/ui";
import { useDownloadsStore } from "./store";

const TOKENS = [
  "{filename}",
  "{name}",
  "{ext}",
  "{title}",
  "{page}",
  "{site}",
  "{host}",
  "{date}",
  "{time}",
  "{kind}",
  "{n:3}",
];
const KINDS: readonly DownloadKind[] = ["image", "video", "audio", "document", "archive", "other"];
const SEGMENT_CHOICES = ["1", "2", "4", "6", "8"] as const;

const PRESETS = [
  { mask: "{filename}", label: "downloads.presetName" },
  { mask: "{site}/{filename}", label: "downloads.presetSite" },
  { mask: "{date} {filename}", label: "downloads.presetDate" },
] as const;

function blankRule(name: string): DownloadRule {
  return {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    host: null,
    kinds: [],
    regex: null,
    mask: null,
    folder: null,
  };
}

export function SettingsTab({ onError }: { onError: (message: string) => void }) {
  const saved = useDownloadsStore((s) => s.settings);
  return saved ? <SettingsForm initial={saved} onError={onError} /> : null;
}

function SettingsForm({
  initial,
  onError,
}: {
  initial: DownloadSettings;
  onError: (message: string) => void;
}) {
  const defaultFolder = useDownloadsStore((s) => s.defaultFolder);
  const saveSettings = useDownloadsStore((s) => s.saveSettings);
  const [draft, setDraft] = useState(initial);
  const [justSaved, setJustSaved] = useState(false);
  const t = useT();

  const change = (changes: Partial<DownloadSettings>) => {
    setJustSaved(false);
    setDraft({ ...draft, ...changes });
  };
  const changeRule = (id: string, changes: Partial<DownloadRule>) =>
    change({ rules: draft.rules.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)) });
  const save = () => {
    saveSettings(draft).then(
      (next) => {
        setDraft(next);
        setJustSaved(true);
      },
      (error: unknown) => onError(String(error)),
    );
  };

  return (
    <div className="flex flex-col gap-9">
      <Group>
        <Switch
          label={t("downloads.settingsButton")}
          description={t("downloads.settingsButtonNote")}
          checked={draft.button}
          onChange={(on) => change({ button: on })}
        />
      </Group>

      <Section title={t("downloads.folder")} note={t("downloads.folderNote")}>
        <input
          value={draft.folder ?? ""}
          onChange={(event) => change({ folder: event.target.value || null })}
          placeholder={defaultFolder}
          aria-label={t("downloads.folder")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`${field} font-mono text-sm`}
        />
      </Section>

      <Section title={t("downloads.segments")} note={t("downloads.segmentsNote")}>
        <Segmented
          label={t("downloads.segments")}
          value={String(draft.segments) as (typeof SEGMENT_CHOICES)[number]}
          options={SEGMENT_CHOICES.map((value) => ({ value, label: value }))}
          onChange={(value) => change({ segments: Number(value) })}
        />
      </Section>

      <Section title={t("downloads.mask")} note={t("downloads.maskNote")}>
        <div className="flex flex-col gap-2">
          <input
            value={draft.mask}
            onChange={(event) => change({ mask: event.target.value })}
            aria-label={t("downloads.mask")}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`${field} font-mono text-sm`}
          />
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((preset) => (
              <button
                key={preset.mask}
                type="button"
                className={quietButton}
                onClick={() => change({ mask: preset.mask })}
              >
                {t(preset.label)}
              </button>
            ))}
          </div>
          <p className="font-mono text-xs leading-relaxed break-words text-paper/50" dir="ltr">
            {TOKENS.join("  ")}
          </p>
        </div>
      </Section>

      <Section title={t("downloads.rules")} note={t("downloads.rulesNote")}>
        <div className="flex flex-col gap-3">
          {draft.rules.map((rule) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onChange={(changes) => changeRule(rule.id, changes)}
              onDelete={() =>
                change({ rules: draft.rules.filter((other) => other.id !== rule.id) })
              }
            />
          ))}
          <button
            type="button"
            className={quietButton}
            onClick={() => change({ rules: [...draft.rules, blankRule(t("downloads.ruleNew"))] })}
          >
            {t("downloads.ruleAdd")}
          </button>
        </div>
      </Section>

      <button type="button" onClick={save} className={primaryBlockButton}>
        {t(justSaved ? "downloads.saved" : "downloads.save")}
      </button>
    </div>
  );
}

function RuleEditor({
  rule,
  onChange,
  onDelete,
}: {
  rule: DownloadRule;
  onChange: (changes: Partial<DownloadRule>) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const text = (value: string | null) => value ?? "";
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-hair bg-paper/[0.04] p-3">
      <input
        value={rule.name}
        onChange={(event) => onChange({ name: event.target.value })}
        aria-label={t("downloads.ruleName")}
        className={field}
      />
      <input
        value={text(rule.host)}
        onChange={(event) => onChange({ host: event.target.value || null })}
        placeholder={t("downloads.ruleSite")}
        aria-label={t("downloads.ruleSite")}
        spellCheck={false}
        autoCapitalize="off"
        className={field}
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("downloads.ruleKinds")}>
        {KINDS.map((kind) => {
          const on = rule.kinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange({
                  kinds: on ? rule.kinds.filter((k) => k !== kind) : [...rule.kinds, kind],
                })
              }
              className={`rounded-full border px-3 py-1 text-sm ${
                on ? "border-accent bg-accent text-on-accent" : "border-hair text-paper/75"
              }`}
            >
              {t(`downloads.kind.${kind}`)}
            </button>
          );
        })}
      </div>
      <input
        value={text(rule.regex)}
        onChange={(event) => onChange({ regex: event.target.value || null })}
        placeholder={t("downloads.ruleRegex")}
        aria-label={t("downloads.ruleRegex")}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={`${field} font-mono text-sm`}
      />
      <input
        value={text(rule.folder)}
        onChange={(event) => onChange({ folder: event.target.value || null })}
        placeholder={t("downloads.ruleFolder")}
        aria-label={t("downloads.ruleFolder")}
        spellCheck={false}
        autoCapitalize="off"
        className={`${field} font-mono text-sm`}
      />
      <input
        value={text(rule.mask)}
        onChange={(event) => onChange({ mask: event.target.value || null })}
        placeholder={t("downloads.ruleMask")}
        aria-label={t("downloads.ruleMask")}
        spellCheck={false}
        autoCapitalize="off"
        className={`${field} font-mono text-sm`}
      />
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={rule.enabled}
          onClick={() => onChange({ enabled: !rule.enabled })}
          className={quietButton}
        >
          {t(rule.enabled ? "downloads.ruleOn" : "downloads.ruleOff")}
        </button>
        <button type="button" onClick={onDelete} className={dangerButton}>
          {t("downloads.ruleDelete")}
        </button>
      </div>
    </div>
  );
}
