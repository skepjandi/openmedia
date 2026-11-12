import { describe, expect, it } from "vitest";
import type { ShareStatus } from "./ipc";
import {
  errorKey,
  initialShare,
  shareReducer,
  summaryToSend,
  type ShareAction,
  type ShareFlow,
} from "./shareFlow";

const status = (state: ShareStatus["state"], extra: Partial<ShareStatus> = {}): ShareStatus => ({
  state,
  prUrl: null,
  login: null,
  error: null,
  errorCode: null,
  ...extra,
});

const run = (actions: ShareAction[], from: ShareFlow = initialShare): ShareFlow =>
  actions.reduce(shareReducer, from);

describe("shareReducer", () => {
  it("goes from idle to polling once the Worker returns an id", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "starting" });
    expect(run([{ type: "start" }, { type: "started", id: "a" }])).toEqual({
      phase: "polling",
      id: "a",
      status: null,
    });
  });

  it("shows a device-side refusal as plain text", () => {
    const flow = run([{ type: "start" }, { type: "refused", message: "Scripts are not allowed" }]);
    expect(flow).toEqual({ phase: "refused", message: "Scripts are not allowed" });
  });

  it("follows waiting, working and done", () => {
    const flow = run([
      { type: "start" },
      { type: "started", id: "a" },
      { type: "polled", id: "a", status: status("waiting") },
      { type: "polled", id: "a", status: status("working") },
      { type: "polled", id: "a", status: status("done", { prUrl: "https://x/pr/1", login: "me" }) },
    ]);
    expect(flow).toEqual({ phase: "done", id: "a", prUrl: "https://x/pr/1", login: "me" });
  });

  it("keeps the fixed error code of a failed share", () => {
    const flow = run([
      { type: "start" },
      { type: "started", id: "a" },
      {
        type: "polled",
        id: "a",
        status: status("failed", { error: "Too many.", errorCode: "limit" }),
      },
    ]);
    expect(flow).toEqual({ phase: "failed", errorCode: "limit", error: "Too many." });
  });

  it("drops answers for another share and answers older than the one shown", () => {
    const polling = run([
      { type: "start" },
      { type: "started", id: "a" },
      { type: "polled", id: "a", status: status("working") },
    ]);
    expect(shareReducer(polling, { type: "polled", id: "b", status: status("done") })).toBe(
      polling,
    );
    expect(shareReducer(polling, { type: "polled", id: "a", status: status("waiting") })).toBe(
      polling,
    );
  });

  it("ignores every answer once polling has ended", () => {
    const done = run([
      { type: "start" },
      { type: "started", id: "a" },
      { type: "polled", id: "a", status: status("done") },
    ]);
    expect(shareReducer(done, { type: "polled", id: "a", status: status("working") })).toBe(done);
    expect(shareReducer(done, { type: "timeout", id: "a" })).toBe(done);
    expect(shareReducer(done, { type: "pollFailed", id: "a" })).toBe(done);
  });

  it("times out only the share it was started for, and resets", () => {
    const polling = run([{ type: "start" }, { type: "started", id: "a" }]);
    expect(shareReducer(polling, { type: "timeout", id: "b" })).toBe(polling);
    expect(shareReducer(polling, { type: "timeout", id: "a" })).toEqual({ phase: "timeout" });
    expect(shareReducer(polling, { type: "reset" })).toEqual(initialShare);
  });
});

describe("errorKey", () => {
  it("maps each code and falls back to the generic sentence", () => {
    expect(errorKey("tooNew")).toBe("share.github.error.tooNew");
    expect(errorKey("cancelled")).toBe("share.github.error.cancelled");
    expect(errorKey(null)).toBe("share.github.error.failed");
  });
});

describe("cancel", () => {
  it("returns to idle", () => {
    const polling = run([{ type: "start" }, { type: "started", id: "a" }]);
    expect(shareReducer(polling, { type: "cancel" })).toEqual(initialShare);
  });
});

describe("summaryToSend", () => {
  it("limits the summary to 140 characters", () => {
    expect(summaryToSend("  hi  ")).toBe("hi");
    expect(summaryToSend("a".repeat(140))).toHaveLength(140);
    expect(summaryToSend("a".repeat(141))).toBeNull();
    expect(summaryToSend("   ")).toBeNull();
  });
});
