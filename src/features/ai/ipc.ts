import { Channel, invoke } from "@tauri-apps/api/core";
import type { OptionGroup } from "../../shared/ipc";

/** What `ai_prepare` returns: the exact text that `ai_send` will send, for the user to read. */
export interface PreparedRequest {
  id: string;
  providerName: string;
  model: string | null;
  /** The site the request is about (a registrable domain): the chat belongs to it. */
  domain: string;
  /** The recipe that already covers the page, when one does. */
  recipeId: string | null;
  recipeName: string | null;
  /** System prompt plus user message, exactly as sent. */
  payload: string;
  tokenEstimate: number;
}

export interface ProposalRule {
  label: string;
  selector: string;
  /** Elements this rule hides on the page right now. */
  matches: number;
}

export interface Proposal {
  id: string;
  kind: "existingOption" | "newOption";
  summary: string;
  recipeId: string;
  recipeName: string;
  option: { id: string | null; label: string; description: string; group: OptionGroup };
  rules: ProposalRule[];
  /** Rules that matched nothing. */
  unmatched: number;
}

export interface HubProposalTab {
  label: string;
  url: string;
  host: string;
  sourceRecipeId: string;
  sourceRecipeName: string;
}

export interface HubProposal {
  id: string;
  name: string;
  recipeId: string;
  summary: string;
  tabs: HubProposalTab[];
}

export interface SavedHub {
  recipeId: string;
  name: string;
}

export type StepKind =
  "readPage" | "askModel" | "checkAnswer" | "previewOnPage" | "countMatches" | "repair";

export type StepStatus = "running" | "done" | "failed";

/**
 * One thing the assistant did for a request. Rust reports these while the model answers; only
 * counts and fixed kinds travel, and the shell writes the sentence for each.
 */
export interface ActivityStep {
  kind: StepKind;
  status: StepStatus;
  /** 0 for the first answer, then 1 and 2 for repairs. */
  round: number;
  /** `countMatches`: rules that found at least one element. */
  matched: number | null;
  /**
   * `countMatches` and `previewOnPage`: the rules in the answer. `repair`: rules that matched
   * nothing, `null` when the answer failed validation. `readPage`: the token estimate.
   */
  total: number | null;
}

/** How an earlier request of the chat ended, as the next request's prompt hears of it. */
export interface EarlierTurn {
  request: string;
  outcome: "applied" | "rejected" | "failed";
}

export type TurnOutcome =
  | { status: "proposed"; proposal: Proposal }
  | { status: "accepted"; proposal: Proposal }
  | { status: "rejected"; proposal: Proposal }
  | { status: "failed"; kind: string; text: string | null };

export interface ChatTurn {
  id: string;
  request: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** The provider that was asked, by the name the user gave it. */
  provider: string | null;
  steps: ActivityStep[];
  outcome: TurnOutcome;
}

/** A saved chat. It belongs to a site and, once the assistant proposed something, to a recipe. */
export interface ChatSession {
  id: string;
  /** The site's registrable domain. */
  domain: string;
  recipeId: string | null;
  recipeName: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

/**
 * The assistant's own commands. They live beside the feature that uses them, so the shared IPC
 * module keeps only what the rest of the app needs. The keys never pass through here: Rust reads
 * them from the secure store when it makes the request.
 */
export const assistant = {
  /** Reads the open page, redacts it and builds the request. Nothing leaves the device yet. */
  prepare: (request: string, earlier: EarlierTurn[]) =>
    invoke<PreparedRequest>("ai_prepare", { chat: { request, earlier } }),
  /** Sends a prepared request and previews the answer on the page; `onActivity` hears each step. */
  send: (id: string, onActivity: (step: ActivityStep) => void) => {
    const channel = new Channel<ActivityStep>();
    channel.onmessage = onActivity;
    return invoke<Proposal>("ai_send", { id, onActivity: channel });
  },
  /** Searches the signed marketplace and returns a validated, unsaved hub proposal. */
  buildHub: (request: string) => invoke<HubProposal>("ai_hub_build", { request }),
  /** Saves an accepted hub; the marketplace submission remains a separate user action. */
  acceptHub: (id: string) => invoke<SavedHub>("ai_hub_accept", { id }),
  /** Drops the proposal without saving it. */
  rejectHub: async (id: string): Promise<void> => {
    await invoke("ai_hub_reject", { id });
  },
  /** Saves the proposal as a switch and removes the preview. */
  accept: async (id: string): Promise<void> => {
    await invoke("ai_accept", { id });
  },
  /** Removes the preview and drops the proposal. */
  reject: async (id: string): Promise<void> => {
    await invoke("ai_reject", { id });
  },
  /** Turns the "show what will be sent" step on or off. */
  setPreview: async (enabled: boolean): Promise<void> => {
    await invoke("set_ai_preview", { enabled });
  },
};

/** Saved chats. Rust writes nothing in incognito, so a chat there lives only in the shell. */
export const chats = {
  list: () => invoke<ChatSession[]>("chat_list"),
  save: async (session: ChatSession): Promise<void> => {
    await invoke("chat_save", { session });
  },
  remove: async (id: string): Promise<void> => {
    await invoke("chat_delete", { id });
  },
  clear: async (): Promise<void> => {
    await invoke("chat_clear");
  },
};
