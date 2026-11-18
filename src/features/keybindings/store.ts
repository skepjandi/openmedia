import { create } from "zustand";
import { PROFILES, type Profile } from "./presets";
import type { Overrides } from "./keymap";

const STORAGE_KEY = "om.keybindings";

interface Saved {
  enabled: boolean;
  profile: Profile;
  overrides: Overrides;
}

const DEFAULTS: Saved = { enabled: true, profile: "standard", overrides: {} };

function isProfile(value: unknown): value is Profile {
  return PROFILES.some((profile) => profile === value);
}

function readOverrides(value: unknown): Overrides {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value).flatMap(([id, sequences]) =>
    Array.isArray(sequences) && sequences.every((s) => typeof s === "string")
      ? [[id, sequences as string[]] as const]
      : [],
  );
  return Object.fromEntries(entries);
}

export function loadSaved(): Saved {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value === "object") {
      const saved = value as Record<string, unknown>;
      return {
        enabled: saved.enabled !== false,
        profile: isProfile(saved.profile) ? saved.profile : DEFAULTS.profile,
        overrides: readOverrides(saved.overrides),
      };
    }
  } catch {
    // unreadable saved keys fall back to the defaults
  }
  return DEFAULTS;
}

interface KeybindingsStore extends Saved {
  setEnabled: (enabled: boolean) => void;
  setProfile: (profile: Profile) => void;
  /** Replaces every key the action had; an empty list leaves it unbound. */
  setBinding: (id: string, sequences: readonly string[]) => void;
  /** Gives the action back the keys its profile gives it. */
  resetBinding: (id: string) => void;
  resetAll: () => void;
  /** A shortcut is being recorded: no key may run an action meanwhile. Never saved. */
  capturing: boolean;
  setCapturing: (capturing: boolean) => void;
}

export const useKeybindings = create<KeybindingsStore>((set, get) => {
  const save = (changes: Partial<Saved>) => {
    set(changes);
    const { enabled, profile, overrides } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, profile, overrides }));
    } catch {
      // the choice still holds for this session
    }
  };
  return {
    ...loadSaved(),
    capturing: false,
    setCapturing: (capturing) => set({ capturing }),
    setEnabled: (enabled) => save({ enabled }),
    setProfile: (profile) => save({ profile }),
    setBinding: (id, sequences) => save({ overrides: { ...get().overrides, [id]: sequences } }),
    resetBinding: (id) => {
      const rest = Object.entries(get().overrides).filter(([key]) => key !== id);
      save({ overrides: Object.fromEntries(rest) });
    },
    resetAll: () => save({ overrides: {} }),
  };
});
