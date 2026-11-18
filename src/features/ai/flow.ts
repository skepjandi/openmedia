import type { ActivityStep, Answer, PreparedRequest, Proposal } from "./ipc";
import { classifyError, nothingMatched, type AssistantError } from "./errors";

/** What every request in flight carries: who it is, what was asked, and what has happened so far. */
interface Live {
  /** Names the turn in the chat that this request becomes. */
  turnId: string;
  request: string;
  steps: ActivityStep[];
  /** The provider asked, known once the request is prepared. */
  provider: string | null;
}

/** One request, from the user's words to a saved switch. */
export type AssistantState =
  | { status: "idle"; draft: string }
  | ({ status: "preparing" } & Live)
  | ({ status: "preview"; prepared: PreparedRequest } & Live)
  | ({ status: "sending"; prepared: PreparedRequest } & Live)
  | ({ status: "proposal"; proposal: Proposal } & Live)
  | ({ status: "accepting"; proposal: Proposal } & Live)
  | ({ status: "accepted"; proposal: Proposal } & Live)
  | ({ status: "rejected"; proposal: Proposal } & Live)
  /** A question answered in words: nothing is left in Rust to accept or reject. */
  | ({ status: "answered"; answer: Answer } & Live)
  /** `jobId` is a prepared request Rust still holds; it must be dropped when leaving. */
  | ({ status: "error"; error: AssistantError; jobId: string | null } & Live);

export type AssistantEvent =
  | { type: "submit"; request: string; turnId: string }
  /** The user typing in the empty bar: the text stays in the state, so it survives a round trip. */
  | { type: "edit"; text: string }
  /** `preview` false (the user turned the preview off) goes straight to sending. */
  | { type: "prepared"; prepared: PreparedRequest; preview: boolean }
  | { type: "send" }
  /** Rust reported a step while the model works. */
  | { type: "activity"; step: ActivityStep }
  | { type: "proposed"; proposal: Proposal }
  | { type: "answered"; answer: Answer }
  | { type: "accept" }
  | { type: "accepted" }
  | { type: "reject" }
  | { type: "failed"; error: unknown }
  /** Back to the empty bar, keeping the request text for editing when `keepText`. */
  | { type: "reset"; keepText?: boolean };

export const initialAssistant: AssistantState = { status: "idle", draft: "" };

/** The prepared request Rust still holds for this state, if any. */
export function pendingJobId(state: AssistantState): string | null {
  switch (state.status) {
    case "preview":
    case "sending":
      return state.prepared.id;
    case "proposal":
    case "accepting":
      return state.proposal.id;
    case "error":
      return state.jobId;
    default:
      return null;
  }
}

/**
 * True when a new switch has only style rules and every one matched nothing, so accepting it
 * would do nothing. A script rule is never counted, so a proposal with one is not "nothing".
 */
export function matchedNothing(proposal: Proposal): boolean {
  return (
    proposal.kind === "newOption" &&
    proposal.rules.length > 0 &&
    proposal.rules.every((rule) => rule.kind === "style" && rule.matches <= 0)
  );
}

const requestOf = (state: AssistantState): string => ("request" in state ? state.request : "");

const readingPage: ActivityStep = {
  kind: "readPage",
  status: "running",
  round: 0,
  matched: null,
  total: null,
};

/** A step replaces the earlier report of the same kind and round (running, then done), else it is added. */
export function withStep(steps: ActivityStep[], step: ActivityStep): ActivityStep[] {
  const index = steps.findIndex((s) => s.kind === step.kind && s.round === step.round);
  if (index === -1) return [...steps, step];
  return steps.map((s, i) => (i === index ? step : s));
}

const failRunning = (steps: ActivityStep[]): ActivityStep[] =>
  steps.map((step) => (step.status === "running" ? { ...step, status: "failed" } : step));

/** Events that do not fit the current state are ignored, so a late async result cannot revive a cancelled request. */
export function assistantReducer(state: AssistantState, event: AssistantEvent): AssistantState {
  switch (event.type) {
    case "submit": {
      const request = event.request.trim();
      if (request === "") return state;
      if (
        state.status !== "idle" &&
        state.status !== "error" &&
        state.status !== "rejected" &&
        state.status !== "answered"
      ) {
        return state;
      }
      return {
        status: "preparing",
        turnId: event.turnId,
        request,
        steps: [readingPage],
        provider: null,
      };
    }
    case "edit":
      return state.status === "idle" ? { status: "idle", draft: event.text } : state;
    case "prepared": {
      if (state.status !== "preparing") return state;
      const { turnId, request } = state;
      const steps = withStep(state.steps, {
        ...readingPage,
        status: "done",
        total: event.prepared.tokenEstimate,
      });
      return {
        status: event.preview ? "preview" : "sending",
        turnId,
        request,
        steps,
        provider: event.prepared.providerName,
        prepared: event.prepared,
      };
    }
    case "send":
      return state.status === "preview" ? { ...state, status: "sending" } : state;
    case "activity":
      return state.status === "sending"
        ? { ...state, steps: withStep(state.steps, event.step) }
        : state;
    case "proposed": {
      if (state.status !== "sending") return state;
      const { turnId, request, steps, provider } = state;
      if (matchedNothing(event.proposal)) {
        return {
          status: "error",
          turnId,
          request,
          steps,
          provider,
          error: nothingMatched(),
          jobId: event.proposal.id,
        };
      }
      return { status: "proposal", turnId, request, steps, provider, proposal: event.proposal };
    }
    case "answered": {
      if (state.status !== "sending") return state;
      const { turnId, request, steps, provider } = state;
      return { status: "answered", turnId, request, steps, provider, answer: event.answer };
    }
    case "accept":
      return state.status === "proposal" ? { ...state, status: "accepting" } : state;
    case "accepted":
      return state.status === "accepting" ? { ...state, status: "accepted" } : state;
    case "reject":
      return state.status === "proposal" ? { ...state, status: "rejected" } : state;
    case "failed": {
      if (
        state.status === "idle" ||
        state.status === "accepted" ||
        state.status === "rejected" ||
        state.status === "answered"
      ) {
        return state;
      }
      const jobId =
        state.status === "accepting"
          ? state.proposal.id
          : state.status === "error"
            ? state.jobId
            : null;
      return {
        status: "error",
        turnId: state.turnId,
        request: requestOf(state),
        steps: failRunning(state.steps),
        provider: state.provider,
        error: classifyError(event.error),
        jobId,
      };
    }
    case "reset":
      return { status: "idle", draft: event.keepText ? requestOf(state) : "" };
  }
}
