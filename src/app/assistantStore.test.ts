import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { useApp } from "./store";
import { useChat } from "../features/ai/chatStore";
import { initialAssistant } from "../features/ai/flow";
import { newSession } from "../features/web/sessions";
import { prepared, proposal } from "../features/ai/fixtures";
import type { AppState } from "../shared/ipc";
import type { ChatSession } from "../features/ai/ipc";
import { useEntitlementStore } from "../features/paywall/store";

const appState = (aiPreview: boolean) =>
  ({ aiPreview, theme: "system", favorites: [], history: [] }) as unknown as AppState;

/** The chats Rust was asked to save, in order. */
let savedChats: ChatSession[] = [];

function mockCommands(overrides: Record<string, (args?: unknown) => unknown> = {}) {
  invoke.mockImplementation(async (name: string, args?: unknown) => {
    if (name === "chat_save") {
      const payload = args as { session: ChatSession };
      savedChats = [...savedChats, payload.session];
    }
    if (overrides[name]) return overrides[name](args);
    switch (name) {
      case "ai_prepare":
        return prepared;
      case "ai_send":
        return { type: "proposal", proposal };
      case "get_sites":
        return [];
      default:
        return undefined;
    }
  });
}

const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);

/** The chat Rust was asked to save last. */
const savedChat = () => savedChats[savedChats.length - 1];

beforeEach(() => {
  invoke.mockReset();
  savedChats = [];
  useApp.setState({
    assistant: initialAssistant,
    state: appState(true),
    sheet: "assistant",
    sites: [],
    sessions: [
      {
        ...newSession("s1", "typed", "https://www.youtube.com/", 0),
        url: "https://www.youtube.com/watch",
      },
    ],
    activeId: "s1",
  });
  useChat.setState({ chats: [], loaded: true, activeId: null, blankDomain: null });
  useEntitlementStore.setState({ status: "pro", configured: true, snapshot: null });
});

describe("assistant wiring", () => {
  it("prepares, waits for Send, then shows the proposal and closes the bar", async () => {
    mockCommands();
    await useApp.getState().submitRequest("hide the suggested videos");
    expect(invoke).toHaveBeenCalledWith("ai_prepare", {
      chat: { request: "hide the suggested videos", earlier: [] },
    });
    expect(useApp.getState().assistant.status).toBe("preview");
    expect(calls("ai_send")).toHaveLength(0);

    await useApp.getState().confirmSend();
    expect(invoke).toHaveBeenCalledWith("ai_send", {
      id: "job-1",
      onActivity: expect.anything(),
    });
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

  it("shows each step Rust reports while the model works", async () => {
    mockCommands({
      ai_send: (args) => {
        const { onActivity } = args as { onActivity: { onmessage: (step: unknown) => void } };
        onActivity.onmessage({
          kind: "askModel",
          status: "running",
          round: 0,
          matched: null,
          total: null,
        });
        expect(useApp.getState().assistant).toMatchObject({
          status: "sending",
          steps: [
            { kind: "readPage", status: "done" },
            { kind: "askModel", status: "running" },
          ],
        });
        return { type: "proposal", proposal };
      },
    });
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide stories");
    expect(useApp.getState().assistant.status).toBe("proposal");
  });

  it("keeps the chat with the site: proposed, then accepted, in the same turn", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide the suggested videos");
    const saved = savedChat();
    expect(saved).toMatchObject({
      domain: "youtube.com",
      recipeId: "youtube",
      title: "hide the suggested videos",
      turns: [{ request: "hide the suggested videos", outcome: { status: "proposed" } }],
    });

    await useApp.getState().acceptProposal();
    const accepted = savedChat();
    expect(accepted.turns).toHaveLength(1);
    expect(accepted.turns[0].outcome.status).toBe("accepted");
    expect(accepted.id).toBe(saved.id);
  });

  it("continues the chat of the site and tells the next prompt what happened before", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide the suggested videos");
    await useApp.getState().rejectProposal();
    useApp.getState().cancelAssistant();

    await useApp.getState().submitRequest("hide the end screen");
    const prepares = calls("ai_prepare");
    const lastPrepare = prepares[prepares.length - 1];
    expect(lastPrepare[1]).toEqual({
      chat: {
        request: "hide the end screen",
        earlier: [{ request: "hide the suggested videos", outcome: "rejected" }],
      },
    });
    const [chat] = useChat.getState().chats;
    expect(useChat.getState().chats).toHaveLength(1);
    expect(chat.turns.map((turn) => turn.request)).toEqual([
      "hide the suggested videos",
      "hide the end screen",
    ]);
  });

  it("cancelling an open proposal is recorded as rejected", async () => {
    mockCommands();
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide stories");
    useApp.getState().cancelAssistant(true);
    expect(useChat.getState().chats[0].turns[0].outcome.status).toBe("rejected");
  });

  it("retrying a failed request replaces its turn instead of adding another", async () => {
    mockCommands({
      ai_send: () => {
        throw "Could not reach the provider.";
      },
    });
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("hide stories");
    expect(useChat.getState().chats[0].turns[0].outcome).toMatchObject({
      status: "failed",
      kind: "network",
    });

    mockCommands();
    await useApp.getState().retryAssistant();
    const { turns } = useChat.getState().chats[0];
    expect(turns).toHaveLength(1);
    expect(turns[0].outcome.status).toBe("proposed");
  });

  it("keeps an answer in the chat and leaves the bar ready for the next question", async () => {
    const answer = {
      text: "Saved posts are under Saved.",
      links: [{ label: "Saved", url: "https://www.youtube.com/saved" }],
    };
    mockCommands({ ai_send: () => ({ type: "answer", answer }) });
    useApp.setState({ state: appState(false) });
    await useApp.getState().submitRequest("where are my saved posts");
    expect(useApp.getState().assistant.status).toBe("idle");
    expect(useApp.getState().sheet).toBe("assistant");
    const [chat] = useChat.getState().chats;
    expect(chat.recipeId).toBeNull();
    expect(chat.turns[0]).toMatchObject({
      request: "where are my saved posts",
      outcome: { status: "answered", answer },
    });
    expect(savedChat().turns[0].outcome.status).toBe("answered");
  });

  it("holds the answer for the dock when the bar was closed meanwhile", async () => {
    mockCommands({
      ai_send: () => ({ type: "answer", answer: { text: "Under Saved.", links: [] } }),
    });
    useApp.setState({ state: appState(false) });
    const pending = useApp.getState().submitRequest("where are my saved posts");
    useApp.setState({ sheet: "none" });
    await pending;
    expect(useApp.getState().assistant.status).toBe("answered");
    useApp.getState().cancelAssistant();
    expect(useApp.getState().assistant.status).toBe("idle");
  });
});
