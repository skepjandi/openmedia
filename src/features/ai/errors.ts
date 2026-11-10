import type { MessageKey } from "../../i18n/messages";

export type AssistantErrorKind =
  | "missingKey"
  | "rateLimit"
  | "network"
  | "provider"
  | "invalid"
  | "nothingMatched"
  | "noPage"
  | "other";

export interface AssistantError {
  kind: AssistantErrorKind;
  /** The fixed line for this kind. `null` when Rust's own short text is shown instead. */
  key: MessageKey | null;
  /** The text Rust sent, shown only when there is no fixed line for the kind. */
  text: string | null;
}

const MESSAGES: Record<Exclude<AssistantErrorKind, "other">, MessageKey> = {
  missingKey: "assistant.errorMissingKey",
  rateLimit: "assistant.errorRateLimit",
  network: "assistant.errorNetwork",
  provider: "assistant.errorProvider",
  invalid: "assistant.errorInvalid",
  nothingMatched: "assistant.errorNothingMatched",
  noPage: "assistant.blockedNoPage",
};

export function nothingMatched(): AssistantError {
  return { kind: "nothingMatched", key: MESSAGES.nothingMatched, text: null };
}

const OTHER_LIMIT = 160;

/**
 * Maps what a Rust command rejected with onto the fixed taxonomy. Rust sends short fixed texts
 * without keys or provider bodies, so matching on them is safe; anything unknown is shown only
 * if it is short, otherwise replaced by a generic line.
 */
export function classifyError(error: unknown): AssistantError {
  const raw =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  const kind: AssistantErrorKind = /rate.?limit|quota|too many requests|429/.test(text)
    ? "rateLimit"
    : /\bkey\b|unauthori[sz]ed|\b40[13]\b|no active provider|no provider/.test(text)
      ? "missingKey"
      : /no (open|active) (page|site|session)|open a site/.test(text)
        ? "noPage"
        : /could not reach|network|connect|timed out|timeout|offline|secure connection/.test(text)
          ? "network"
          : /nothing matched|matched nothing|no match/.test(text)
            ? "nothingMatched"
            : /invalid|expected form|structure|unusable|refus|not understood|validat|rejected the change/.test(
                  text,
                )
              ? "invalid"
              : /provider|status|server/.test(text)
                ? "provider"
                : "other";

  if (kind === "other") {
    const short = raw.trim().length > 0 && raw.trim().length <= OTHER_LIMIT;
    return short
      ? { kind, key: null, text: raw.trim() }
      : { kind, key: "assistant.errorOther", text: null };
  }
  return { kind, key: MESSAGES[kind], text: null };
}

/** The error a saved turn recorded, shown again from its class and short text. */
export function restoreError(kind: string, text: string | null): AssistantError {
  if (Object.keys(MESSAGES).includes(kind)) {
    const known = kind as keyof typeof MESSAGES;
    return { kind: known, key: MESSAGES[known], text: null };
  }
  return text
    ? { kind: "other", key: null, text }
    : { kind: "other", key: "assistant.errorOther", text: null };
}
