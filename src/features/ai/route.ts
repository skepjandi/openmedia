import type { AiState, SearchEngine } from "../../shared/ipc";
import { searchUrl } from "../../shared/searchEngines";
import { normalizeWebUrl } from "../../shared/url";

export const MAX_REQUEST_LENGTH = 400;

/** What the user wants the bar to do with the text. `auto` decides from the text itself. */
export type InputMode = "auto" | "link" | "search" | "chat";
export const INPUT_MODES: readonly InputMode[] = ["auto", "link", "search", "chat"];

export type Route =
  | { kind: "empty" }
  | { kind: "address"; url: string }
  | { kind: "search"; url: string }
  | { kind: "request"; request: string }
  | { kind: "notLink" }
  | { kind: "paywall" }
  | { kind: "blocked"; reason: "noProvider" | "noPage" };

export interface RouteContext {
  /** `null` while provider settings have not loaded. */
  ai: AiState | null;
  /** The address of the page the user is on, when a site is open. */
  pageUrl: string | null;
  /** Whether the Pro entitlement is active. The assistant is the only Pro route. */
  pro: boolean;
  mode: InputMode;
  /** The engine a `search` route uses. */
  searchEngine: SearchEngine;
}

/** True when an active provider exists and has a key. */
export function providerReady(ai: AiState | null): boolean {
  const active = ai?.providers.find((p) => p.id === ai.activeId);
  return active?.hasKey === true;
}

const isSitePage = (url: string | null): boolean => url !== null && /^https?:\/\//i.test(url);

// Text that starts like a request to change a page ("hide the suggested videos") goes to the
// assistant in auto mode; anything else is a web search. English only: in other languages, pick
// Chat to reach the assistant.
const REQUEST_START =
  /^(hide|remove|block|show|make|change|turn|disable|enable|mute|stop|delete|filter|clean|declutter|get|only|no|don'?t|without|replace|move|dim|collapse|skip|unfollow)\b/i;

/** An assistant request. Pro is checked first so a free user is shown the paywall, not setup steps. */
function assistantRoute(text: string, context: RouteContext): Route {
  if (!context.pro) return { kind: "paywall" };
  if (!providerReady(context.ai)) return { kind: "blocked", reason: "noProvider" };
  if (!isSitePage(context.pageUrl)) return { kind: "blocked", reason: "noPage" };
  return { kind: "request", request: text.slice(0, MAX_REQUEST_LENGTH) };
}

/**
 * Decides what the typed text does. Links and searches are free; only the assistant is Pro.
 *
 * - `link`: opens the text as an address, or says it is not one.
 * - `search`: searches the web for the text.
 * - `chat`: always a request for the assistant.
 * - `auto`: an address opens, text that starts like a change request goes to the assistant,
 *   anything else is searched.
 */
export function routeInput(text: string, context: RouteContext): Route {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  const url = normalizeWebUrl(trimmed);
  switch (context.mode) {
    case "link":
      return url ? { kind: "address", url } : { kind: "notLink" };
    case "search":
      return { kind: "search", url: searchUrl(trimmed, context.searchEngine) };
    case "chat":
      return assistantRoute(trimmed, context);
    case "auto":
      if (url) return { kind: "address", url };
      if (REQUEST_START.test(trimmed)) return assistantRoute(trimmed, context);
      return { kind: "search", url: searchUrl(trimmed, context.searchEngine) };
  }
}
