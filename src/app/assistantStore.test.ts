import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { initialAssistant } from "../features/ai/flow";
import { prepared, proposal } from "../features/ai/fixtures";
import type { AppState } from "../shared/ipc";
import { useEntitlementStore } from "../features/paywall/store";

const appState = (aiPreview: boolean) =>
  ({ aiPreview, theme: "system", favorites: [], history: [] }) as unknown as AppState;

function mockCommands(overrides: Record<string, (args?: unknown) => unknown> = {}) {
  invoke.mockImplementation(async (name: string, args?: unknown) => {
    if (overrides[name]) return overrides[name](args);
    switch (name) {
      case "ai_prepare":
        return prepared;
      case "ai_send":
        return proposal;
      case "get_sites":
        return [];
      default:
        return undefined;
    }
  });
}

const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    assistant: initialAssistant,
    state: appState(true),
    sheet: "assistant",
    sites: [],
  });
  useEntitlementStore.setState({ status: "pro", configured: true, snapshot: null });
});

describe("assistant wiring", () => {
  it("prepares, waits for Send, then shows the proposal and closes the bar", async () => {
    mockCommands();
    await useApp.getState().submitRequest("hide the suggested videos");
    expect(invoke).toHaveBeenCalledWith("ai_prepare", { request: "hide the suggested videos" });
    expect(useApp.getState().assistant.status).toBe("preview");
    expect(calls("ai_send")).toHaveLength(0);

    await useApp.getState().confirmSend();
    expect(invoke).toHaveBeenCalledWith("ai_send", { id: "job-1" });
    expect(useApp.getState().assistant.status).toBe("proposal");
    expect(useApp.getState().sheet).toBe("none");
  });

  it("sends right away when the preview is off", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide stories");
    expect(calls("ai_send")).toHaveLength(1);
    expect(useApp.getState().assistant.status).toBe("proposal");
  });

  it("routes a rejected AI request to the paywall without leaving a retry error", async () => {
    useEntitlementStore.setState({ status: "free", configured: true, snapshot: null });
    mockCommands({ ai_prepare: () => Promise.reject("pro-required") });
    await useApp.getState().submitRequest("hide stories");
    expect(calls("ai_prepare")).toHaveLength(1);
    expect(useApp.getState().sheet).toBe("paywall");
    expect(useApp.getState().assistant.status).toBe("idle");
  });

  it("keeps the command bar, links and searches free while Usage opens the paywall", () => {
    mockCommands({ add_history: () => [] });
    useEntitlementStore.setState({ status: "free", configured: true, snapshot: null });
    useApp.getState().openSheet("assistant");
    expect(useApp.getState().sheet).toBe("assistant");
    useApp.getState().openSheet("stats");
    expect(useApp.getState().sheet).toBe("paywall");
    useApp.getState().openAddress("https://example.com/");
    expect(useApp.getState().action).toMatchObject({ type: "open", url: "https://example.com/" });
    expect(useApp.getState().sheet).toBe("none");
    useApp.getState().openSearch("https://duckduckgo.com/?q=cats");
    expect(useApp.getState().action).toMatchObject({
      type: "open",
      url: "https://duckduckgo.com/?q=cats",
    });
    expect(calls("add_history")).toHaveLength(1);
  });

  it("accepting saves, reloads the sites and confirms", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide stories");
    await useApp.getState().acceptProposal();
    expect(invoke).toHaveBeenCalledWith("ai_accept", { id: "job-1" });
    expect(calls("get_sites")).toHaveLength(1);
    expect(useApp.getState().assistant.status).toBe("accepted");
  });

  it("rejecting removes the preview", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("x");
    await useApp.getState().rejectProposal();
    expect(invoke).toHaveBeenCalledWith("ai_reject", { id: "job-1" });
    expect(useApp.getState().assistant.status).toBe("rejected");
  });

  it("maps a send failure to a fixed message and drops the job; retry prepares again", async () => {
    mockCommands({
      ai_send: () => {
        throw "The provider is rate limiting this key. Try again shortly.";
      },
    });
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("x");
    const failed = useApp.getState().assistant;
    expect(failed).toMatchObject({ status: "error", error: { kind: "rateLimit" } });
    expect(invoke).toHaveBeenCalledWith("ai_reject", { id: "job-1" });

    mockCommands();
    await useApp.getState().retryAssistant();
    expect(calls("ai_prepare")).toHaveLength(2);
    expect(useApp.getState().assistant.status).toBe("proposal");
  });

  it("cancelling during preparation drops the late result and its job", async () => {
    let release: (value: unknown) => void = () => {};
    mockCommands({ ai_prepare: () => new Promise((resolve) => (release = resolve)) });
    const pending = useApp.getState().submitRequest("x");
    useApp.getState().cancelAssistant();
    release(prepared);
    await pending;
    expect(useApp.getState().assistant.status).toBe("idle");
    expect(invoke).toHaveBeenCalledWith("ai_reject", { id: "job-1" });
  });

  it("cancelling at the preview drops the held job", async () => {
    mockCommands();
    await useApp.getState().submitRequest("x");
    useApp.getState().cancelAssistant();
    expect(invoke).toHaveBeenCalledWith("ai_reject", { id: "job-1" });
    expect(useApp.getState().assistant.status).toBe("idle");
  });

  it("persists the preview setting and rolls back on failure", async () => {
    mockCommands();
    await useApp.getState().setAiPreview(false);
    expect(invoke).toHaveBeenCalledWith("set_ai_preview", { enabled: false });
    expect(useApp.getState().state?.aiPreview).toBe(false);

    mockCommands({
      set_ai_preview: () => {
        throw "nope";
      },
    });
    await useApp.getState().setAiPreview(true);
    expect(useApp.getState().state?.aiPreview).toBe(false);
    expect(useApp.getState().error).toBe("nope");
  });
});
