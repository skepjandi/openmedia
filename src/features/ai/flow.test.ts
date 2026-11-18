import { describe, expect, it } from "vitest";
import { assistantReducer, initialAssistant, matchedNothing, pendingJobId } from "./flow";
import type { AssistantEvent, AssistantState } from "./flow";
import { prepared, proposal } from "./fixtures";

const run = (events: AssistantEvent[], from: AssistantState = initialAssistant) =>
  events.reduce(assistantReducer, from);

const submit = (request = "hide it"): AssistantEvent => ({
  type: "submit",
  request,
  turnId: "turn-1",
});

describe("assistant flow", () => {
  it("goes through the preview to a proposal and accepted", () => {
    const states = [submit(" hide it "), { type: "prepared", prepared, preview: true }] as const;
    const preview = run([...states]);
    expect(preview).toMatchObject({
      status: "preview",
      request: "hide it",
      turnId: "turn-1",
      prepared,
    });
    const accepted = run(
      [{ type: "send" }, { type: "proposed", proposal }, { type: "accept" }, { type: "accepted" }],
      preview,
    );
    expect(accepted.status).toBe("accepted");
  });

  it("skips the preview when it is off", () => {
    const state = run([submit("x"), { type: "prepared", prepared, preview: false }]);
    expect(state.status).toBe("sending");
  });

  it("ignores blank requests and events that do not fit", () => {
    expect(run([submit("  ")])).toBe(initialAssistant);
    expect(run([{ type: "proposed", proposal }])).toBe(initialAssistant);
    expect(run([{ type: "accept" }])).toBe(initialAssistant);
    const preparing = run([submit("a")]);
    expect(assistantReducer(preparing, submit("b"))).toBe(preparing);
  });

  it("keeps what the user typed in the empty bar and ignores edits mid-request", () => {
    const typed = run([{ type: "edit", text: "hide stories" }]);
    expect(typed).toEqual({ status: "idle", draft: "hide stories" });
    const preparing = run([submit("a")]);
    expect(assistantReducer(preparing, { type: "edit", text: "b" })).toBe(preparing);
  });

  it("drops a late result after cancel", () => {
    const cancelled = run([
      submit("a"),
      { type: "reset" },
      { type: "prepared", prepared, preview: true },
    ]);
    expect(cancelled).toEqual({ status: "idle", draft: "" });
  });

  it("reject returns to rejected and ask again keeps the text", () => {
    const rejected = run([
      submit("hide stories"),
      { type: "prepared", prepared, preview: false },
      { type: "proposed", proposal },
      { type: "reject" },
    ]);
    expect(rejected).toMatchObject({ status: "rejected", request: "hide stories" });
    expect(assistantReducer(rejected, { type: "reset", keepText: true })).toEqual({
      status: "idle",
      draft: "hide stories",
    });
  });

  it("maps failures to the taxonomy and keeps the job to drop", () => {
    const failed = run([
      submit("a"),
      { type: "prepared", prepared, preview: false },
      { type: "failed", error: "The provider is rate limiting this key. Try again shortly." },
    ]);
    expect(failed).toMatchObject({ status: "error", error: { kind: "rateLimit" }, jobId: null });
    const retried = assistantReducer(failed, submit("a"));
    expect(retried.status).toBe("preparing");
  });

  it("turns a proposal where nothing matched into the nothing-matched error", () => {
    const none = {
      ...proposal,
      unmatched: 2,
      rules: proposal.rules.map((r) => ({ ...r, matches: 0 })),
    };
    expect(matchedNothing(none)).toBe(true);
    expect(matchedNothing(proposal)).toBe(false);
    const script = {
      label: "Script",
      kind: "script" as const,
      selector: "",
      matches: 0,
      code: "return 1;",
      powers: [],
    };
    expect(matchedNothing({ ...none, rules: [script], unmatched: 0, runsCode: true })).toBe(false);
    expect(matchedNothing({ ...none, rules: [script, ...none.rules] })).toBe(false);
    const state = run([
      submit("a"),
      { type: "prepared", prepared, preview: false },
      { type: "proposed", proposal: none },
    ]);
    expect(state).toMatchObject({
      status: "error",
      error: { kind: "nothingMatched" },
      jobId: "job-1",
    });
    expect(pendingJobId(state)).toBe("job-1");
  });

  it("does not treat an existing switch as matching nothing", () => {
    const existing = { ...proposal, kind: "existingOption" as const, rules: [], unmatched: 0 };
    expect(matchedNothing(existing)).toBe(false);
  });

  it("a failed accept keeps the job so it can be dropped", () => {
    const state = run([
      submit("a"),
      { type: "prepared", prepared, preview: false },
      { type: "proposed", proposal },
      { type: "accept" },
      { type: "failed", error: "could not read or write the library: x" },
    ]);
    expect(state).toMatchObject({ status: "error", jobId: "job-1" });
  });

  it("records the steps of the request and replaces a step with its later state", () => {
    const running = run([
      submit("a"),
      { type: "prepared", prepared, preview: false },
      {
        type: "activity",
        step: { kind: "askModel", status: "running", round: 0, matched: null, total: null },
      },
    ]);
    expect(running).toMatchObject({
      status: "sending",
      steps: [
        { kind: "readPage", status: "done", total: prepared.tokenEstimate },
        { kind: "askModel", status: "running" },
      ],
    });
    const done = assistantReducer(running, {
      type: "activity",
      step: { kind: "askModel", status: "done", round: 0, matched: null, total: null },
    });
    expect(done).toMatchObject({
      steps: [
        { kind: "readPage", status: "done" },
        { kind: "askModel", status: "done" },
      ],
    });
  });

  it("marks a step that was still running as failed when the request fails", () => {
    const failed = run([
      submit("a"),
      { type: "prepared", prepared, preview: false },
      {
        type: "activity",
        step: { kind: "askModel", status: "running", round: 0, matched: null, total: null },
      },
      { type: "failed", error: "Could not reach the provider." },
    ]);
    expect(failed).toMatchObject({
      status: "error",
      steps: [
        { kind: "readPage", status: "done" },
        { kind: "askModel", status: "failed" },
      ],
    });
  });

  it("ignores a step that arrives after the request was cancelled", () => {
    const cancelled = run([submit("a"), { type: "reset" }]);
    const after = assistantReducer(cancelled, {
      type: "activity",
      step: { kind: "askModel", status: "done", round: 0, matched: null, total: null },
    });
    expect(after).toBe(cancelled);
  });

  it("ends a question in an answer that leaves no job and lets the next request start", () => {
    const answer = {
      text: "Saved posts are under Saved.",
      links: [{ label: "Saved", url: "https://example.org/saved" }],
    };
    const answered = run([
      submit("where are my saved posts"),
      { type: "prepared", prepared, preview: false },
      { type: "answered", answer },
    ]);
    expect(answered).toMatchObject({ status: "answered", turnId: "turn-1", answer });
    expect(pendingJobId(answered)).toBeNull();
    expect(assistantReducer(answered, { type: "failed", error: new Error("late") })).toBe(answered);
    expect(assistantReducer(answered, submit("and my settings")).status).toBe("preparing");
    expect(run([{ type: "answered", answer }])).toBe(initialAssistant);
  });
});
