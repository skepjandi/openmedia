import type { Translate } from "./translate";

/** The code Rust sends when the settings lock refuses to relax a restriction. */
export const USAGE_LOCKED = "usage-locked";

/**
 * The message for something that went wrong. Rust sends short fixed texts, so what reaches the
 * user is already safe to show; anything the app cannot describe gets a translated line.
 */
export function describeError(error: unknown, t: Translate): string {
  if (error === USAGE_LOCKED) return t("usage.lock.refused");
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : t("app.unknownError");
}
