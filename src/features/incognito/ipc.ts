import { invoke } from "@tauri-apps/api/core";
import type { Favorite, FavoriteInput } from "../../shared/ipc";

/** Face ID where the device has it, otherwise a fingerprint; only used to pick an icon. */
export type BiometryKind = "face" | "fingerprint";

/**
 * Incognito's own commands, beside the feature that uses them. The biometric prompt is raised by
 * Rust; the shell only passes the sentence the system shows and learns whether the check passed.
 */
export const incognito = {
  /** Which biometric the device has. No prompt; free for every user. */
  biometryKind: () => invoke<BiometryKind>("biometry_kind"),
  /** Asks for Face ID, Touch ID or the passcode. False when cancelled or failed. */
  unlock: (reason: string) => invoke<boolean>("unlock_incognito", { reason }),
  /** Checks first, then turns incognito on and returns its favorites; null when the check failed. */
  enter: (reason: string) => invoke<Favorite[] | null>("enter_incognito", { reason }),
  /** Back to the normal set. No check. */
  exit: async (): Promise<void> => {
    await invoke("exit_incognito");
  },
  favorites: () => invoke<Favorite[]>("get_incognito_favorites"),
  setFavorites: (favorites: FavoriteInput[]) =>
    invoke<Favorite[]>("set_incognito_favorites", { favorites }),
};
