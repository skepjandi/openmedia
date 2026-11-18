import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { isMac } from "../../shared/platform";
import { Screen } from "../../shared/Screen";
import { Segmented } from "../settings/Segmented";
import { NavRow } from "../settings/SiteParts";
import { Switch } from "../settings/Switch";
import { Group, field, quietButton } from "../settings/ui";
import { ACTIONS, ACTIONS_BY_ID, GROUP_ORDER, GROUP_TITLES, type ActionInfo } from "./actionList";
import { chordFromEvent, formatSequence, isReservedChord } from "./chord";
import { conflictsOf, effectiveBindings } from "./keymap";
import { PROFILES, type Profile } from "./presets";
import { useKeybindings } from "./store";

/** The row in Settings that opens the keyboard shortcuts page. Desktop only. */
export function KeybindingsLink() {
  const desktop = useApp((s) => s.desktop);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  if (!desktop) return null;
  return (
    <Group>
      <NavRow
        title={t("settings.keybindings")}
        note={t("settings.keybindingsNote")}
        onClick={() => openSheet("keybindings")}
      />
    </Group>
  );
}

/** How long after the last key a recorded shortcut is complete. */
const RECORD_PAUSE_MS = 900;

interface RecorderProps {
  onDone: (sequence: string) => void;
  onCancel: () => void;
}

/** Listens for the keys of one shortcut: one chord, or several pressed one after the other. */
function Recorder({ onDone, onCancel }: RecorderProps) {
  const t = useT();
  const mac = isMac();
  const [chords, setChords] = useState<string[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef<string[]>([]);
  const finish = useRef({ onDone, onCancel });
  useEffect(() => {
    finish.current = { onDone, onCancel };
  });

  useEffect(() => {
    useKeybindings.getState().setCapturing(true);
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape" && latest.current.length === 0) {
        finish.current.onCancel();
        return;
      }
      const chord = chordFromEvent(event, mac);
      if (!chord) return;
      latest.current = [...latest.current, chord];
      setChords(latest.current);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => finish.current.onDone(latest.current.join(" ")),
        RECORD_PAUSE_MS,
      );
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener("keydown", onKey, true);
      useKeybindings.getState().setCapturing(false);
    };
  }, [mac]);

  return (
    <span className="flex items-center gap-2">
      <kbd className="rounded-lg border border-accent px-2 py-1 font-sans text-sm">
        {chords.length > 0 ? formatSequence(chords.join(" "), mac) : t("keys.recording")}
      </kbd>
      <button type="button" className={quietButton} onClick={onCancel}>
        {t("keys.cancel")}
      </button>
    </span>
  );
}

interface ActionRowProps {
  info: ActionInfo;
  sequences: readonly string[];
  changed: boolean;
  recording: boolean;
  onRecord: () => void;
  onRecorded: (sequence: string) => void;
  onCancel: () => void;
  onRemove: (sequence: string) => void;
  onReset: () => void;
}

function ActionRow({
  info,
  sequences,
  changed,
  recording,
  onRecord,
  onRecorded,
  onCancel,
  onRemove,
  onReset,
}: ActionRowProps) {
  const t = useT();
  const mac = isMac();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="min-w-0 flex-1 basis-48 text-base">{info.label}</span>
      <span className="flex flex-wrap items-center justify-end gap-2">
        {sequences.length === 0 && !recording && (
          <span className="text-sm text-paper/40">{t("keys.unbound")}</span>
        )}
        {sequences.map((sequence) => (
          <span
            key={sequence}
            className="flex items-center gap-1 rounded-lg bg-paper/[0.08] ps-2 text-sm"
          >
            <kbd className="font-sans">{formatSequence(sequence, mac)}</kbd>
            <button
              type="button"
              aria-label={t("keys.remove", { keys: formatSequence(sequence, mac) })}
              onClick={() => onRemove(sequence)}
              className="px-1.5 py-1 text-paper/50 active:text-paper"
            >
              ×
            </button>
          </span>
        ))}
        {recording ? (
          <Recorder onDone={onRecorded} onCancel={onCancel} />
        ) : (
          <button type="button" className={quietButton} onClick={onRecord}>
            {t("keys.add")}
          </button>
        )}
        {changed && !recording && (
          <button type="button" className={quietButton} onClick={onReset}>
            {t("keys.reset")}
          </button>
        )}
      </span>
    </div>
  );
}

/** Every action and the keys that run it; any action can be given any keys, or none. */
export function KeybindingsScreen() {
  const open = useApp((s) => s.sheet === "keybindings");
  const closeSheet = useApp((s) => s.closeSheet);
  const parent = useApp((s) => s.sheetParent);
  const { enabled, profile, overrides } = useKeybindings();
  const { setEnabled, setProfile, setBinding, resetBinding, resetAll } = useKeybindings.getState();
  const t = useT();
  const mac = isMac();
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bindings = useMemo(
    () => effectiveBindings(profile, overrides, mac),
    [profile, overrides, mac],
  );
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  if (!open) return null;

  const accept = (id: string) => (sequence: string) => {
    setRecordingId(null);
    if (!sequence.includes(" ") && isReservedChord(sequence)) {
      setNotice(t("keys.reserved", { keys: formatSequence(sequence, mac) }));
      return;
    }
    const clashes = conflictsOf(bindings, id, sequence).map(
      (other) => ACTIONS_BY_ID[other]?.label ?? other,
    );
    setNotice(clashes.length > 0 ? t("keys.conflict", { name: clashes.join(", ") }) : null);
    setBinding(id, [...new Set([...(bindings.get(id) ?? []), sequence])]);
  };

  const profileLabels: Record<Profile, string> = {
    standard: t("keys.profileStandard"),
    vim: t("keys.profileVim"),
    emacs: t("keys.profileEmacs"),
  };
  const visible = (info: ActionInfo) =>
    words.every((word) => `${info.label} ${GROUP_TITLES[info.group]}`.toLowerCase().includes(word));

  return (
    <Screen
      title={t("keys.title")}
      subtitle={t("keys.subtitle")}
      closeLabel={t(parent === "settings" ? "common.back" : "settings.close")}
      onClose={closeSheet}
      back={parent === "settings"}
    >
      <div className="flex flex-col gap-8">
        <Group>
          <Switch
            label={t("keys.enabled")}
            description={t("keys.enabledNote")}
            checked={enabled}
            onChange={setEnabled}
          />
        </Group>
        <div className="flex flex-col gap-2">
          <Segmented
            label={t("keys.profile")}
            value={profile}
            options={PROFILES.map((value) => ({ value, label: profileLabels[value] }))}
            onChange={setProfile}
          />
          <p className="px-1 text-[13px] leading-snug text-paper/50">{t("keys.profileNote")}</p>
        </div>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("keys.search")}
          aria-label={t("keys.search")}
          spellCheck={false}
          className={field}
        />
        {notice && (
          <p role="status" className="px-1 text-sm text-accent">
            {notice}
          </p>
        )}
        {GROUP_ORDER.map((group) => {
          const infos = ACTIONS.filter((info) => info.group === group && visible(info));
          if (infos.length === 0) return null;
          return (
            <section key={group} className="flex flex-col gap-2">
              <h2 className="eyebrow px-1">{GROUP_TITLES[group]}</h2>
              <Group>
                {infos.map((info) => (
                  <ActionRow
                    key={info.id}
                    info={info}
                    sequences={bindings.get(info.id) ?? []}
                    changed={info.id in overrides}
                    recording={recordingId === info.id}
                    onRecord={() => setRecordingId(info.id)}
                    onRecorded={accept(info.id)}
                    onCancel={() => setRecordingId(null)}
                    onRemove={(sequence) =>
                      setBinding(
                        info.id,
                        (bindings.get(info.id) ?? []).filter((kept) => kept !== sequence),
                      )
                    }
                    onReset={() => resetBinding(info.id)}
                  />
                ))}
              </Group>
            </section>
          );
        })}
        <button type="button" className={quietButton} onClick={resetAll}>
          {t("keys.resetAll")}
        </button>
      </div>
    </Screen>
  );
}
