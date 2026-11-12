import { useCallback, useEffect, useReducer, useRef } from "react";
import type { MessageKey } from "../../i18n/messages";
import { share, type ShareErrorCode, type ShareStatus } from "./ipc";

export const POLL_INTERVAL_MS = 2000;
/** A share session lives 15 minutes on the Worker; polling stops then. */
export const POLL_LIMIT_MS = 15 * 60 * 1000;
export const MAX_SUMMARY_CHARS = 140;

/** The summary as it will be sent: trimmed, 1 to 140 characters. Null otherwise. */
export function summaryToSend(text: string): string | null {
  const trimmed = text.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= MAX_SUMMARY_CHARS ? trimmed : null;
}

/** The sentence each failure code gets. `invalid` shows Rust's own explanation when there is one. */
export const ERROR_KEYS: Record<ShareErrorCode, MessageKey> = {
  tooNew: "share.github.error.tooNew",
  limit: "share.github.error.limit",
  invalid: "share.github.error.invalid",
  offline: "share.github.error.offline",
  busy: "share.github.error.busy",
  failed: "share.github.error.failed",
  cancelled: "share.github.error.cancelled",
};

export function errorKey(code: ShareErrorCode | null): MessageKey {
  return (code !== null && ERROR_KEYS[code]) || "share.github.error.failed";
}

export type ShareFlow =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "polling"; id: string; status: ShareStatus | null }
  | { phase: "done"; id: string; prUrl: string | null; login: string | null }
  | { phase: "failed"; errorCode: ShareErrorCode | null; error: string | null }
  /** The device refused to send the recipe; `message` is Rust's plain sentence. */
  | { phase: "refused"; message: string }
  | { phase: "timeout" };

export type ShareAction =
  | { type: "start" }
  | { type: "started"; id: string }
  | { type: "refused"; message: string }
  | { type: "polled"; id: string; status: ShareStatus }
  | { type: "pollFailed"; id: string }
  | { type: "timeout"; id: string }
  | { type: "cancel" }
  | { type: "reset" };

export const initialShare: ShareFlow = { phase: "idle" };

const RANK: Record<ShareStatus["state"], number> = { waiting: 0, working: 1, done: 2, failed: 2 };

export function shareReducer(flow: ShareFlow, action: ShareAction): ShareFlow {
  switch (action.type) {
    case "start":
      return flow.phase === "idle" ? { phase: "starting" } : flow;
    case "started":
      return flow.phase === "starting" ? { phase: "polling", id: action.id, status: null } : flow;
    case "refused":
      return flow.phase === "starting" ? { phase: "refused", message: action.message } : flow;
    case "polled": {
      // Answers for another share, or arriving after the flow ended, or older than what is shown.
      if (flow.phase !== "polling" || flow.id !== action.id) return flow;
      const { status } = action;
      if (flow.status && RANK[status.state] < RANK[flow.status.state]) return flow;
      if (status.state === "done") {
        return { phase: "done", id: flow.id, prUrl: status.prUrl, login: status.login };
      }
      if (status.state === "failed")
        return { phase: "failed", errorCode: status.errorCode, error: status.error };
      return { phase: "polling", id: flow.id, status };
    }
    case "pollFailed":
      return flow.phase === "polling" && flow.id === action.id
        ? { phase: "failed", errorCode: "offline", error: null }
        : flow;
    case "timeout":
      return flow.phase === "polling" && flow.id === action.id ? { phase: "timeout" } : flow;
    case "cancel":
    case "reset":
      return initialShare;
  }
}

/** The first guess at a description: the recipe's name, cut to fit. */
export const suggestedSummary = (name: string): string =>
  [...name.trim()].slice(0, MAX_SUMMARY_CHARS).join("");

/**
 * Runs the share: starts it, then asks for its status every two seconds until it is done, failed
 * or fifteen minutes old. Polling stops when the screen goes away; nothing is set afterwards.
 */
export function useShare(): {
  flow: ShareFlow;
  begin: (recipeId: string, summary: string) => void;
  /** Stops waiting and tells Rust to drop the share. */
  cancel: () => void;
  reset: () => void;
} {
  const [flow, dispatch] = useReducer(shareReducer, initialShare);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback((action: ShareAction) => {
    if (alive.current) dispatch(action);
  }, []);

  const polledId = flow.phase === "polling" ? flow.id : null;
  useEffect(() => {
    if (polledId === null) return;
    const id = polledId;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      try {
        const status = await share.status(id);
        if (stopped) return;
        send({ type: "polled", id, status });
        if (status.state === "done" || status.state === "failed") return;
      } catch {
        if (!stopped) send({ type: "pollFailed", id });
        return;
      }
      if (Date.now() - startedAt >= POLL_LIMIT_MS) {
        send({ type: "timeout", id });
        return;
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polledId, send]);

  const begin = useCallback(
    (recipeId: string, summary: string) => {
      send({ type: "start" });
      share
        .start(recipeId, summary)
        .then(({ id }) => send({ type: "started", id }))
        .catch((failure: unknown) =>
          send({
            type: "refused",
            message: failure instanceof Error ? failure.message : String(failure),
          }),
        );
    },
    [send],
  );

  const cancel = useCallback(() => {
    if (flow.phase === "polling") void share.cancel(flow.id).catch(() => {});
    send({ type: "cancel" });
  }, [flow, send]);

  const reset = useCallback(() => send({ type: "reset" }), [send]);

  return { flow, begin, cancel, reset };
}
