import { create } from "zustand";
import type { AssistantState } from "./flow";
import { chats as chatIpc, type ChatSession } from "./ipc";
import { newSession, resolveFocus, turnOf, withTurn } from "./chat";

interface ChatStore {
  /** Saved chats, plus the blank one a request is about to fill. */
  chats: ChatSession[];
  loaded: boolean;
  /** The chat the next request continues; `null` is a new chat that does not exist yet. */
  activeId: string | null;
  /** The site the user started a blank chat for; reopening the bar there keeps it blank. */
  blankDomain: string | null;
  /** Counts the chats the user picked to continue, so the bar can leave a mode that hides them. */
  resumed: number;
  load: () => Promise<void>;
  /** Picks the chat to continue for the site on screen. */
  focus: (domain: string | null) => void;
  /** The next request starts a new chat for the site. */
  startNew: (domain: string | null) => void;
  resume: (id: string) => void;
  /** Makes sure the chat the next request goes into exists. */
  begin: (domain: string) => void;
  /** Saves the request in flight, once it has something worth keeping. */
  keep: (state: AssistantState) => void;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  /** Drops what the shell holds, so incognito and normal chats never mix. */
  forget: () => void;
}

export const useChat = create<ChatStore>()((set, get) => ({
  chats: [],
  loaded: false,
  activeId: null,
  blankDomain: null,
  resumed: 0,

  load: async () => {
    try {
      const saved = await chatIpc.list();
      set((current) => ({
        chats: [
          ...saved,
          ...current.chats.filter(
            (chat) => chat.id === current.activeId && !saved.some((s) => s.id === chat.id),
          ),
        ],
        loaded: true,
      }));
    } catch {
      set({ loaded: true });
    }
  },

  focus: (domain) => set((current) => resolveFocus(current.chats, domain, current)),

  startNew: (domain) => set({ activeId: null, blankDomain: domain }),

  resume: (id) =>
    set((current) => ({ activeId: id, blankDomain: null, resumed: current.resumed + 1 })),

  begin: (domain) => {
    const { chats, activeId } = get();
    if (chats.find((chat) => chat.id === activeId)?.domain === domain) return;
    const created = newSession(crypto.randomUUID(), domain, Date.now());
    set((current) => ({
      // A chat that never got a turn is not worth keeping.
      chats: [
        created,
        ...current.chats.filter((chat) => chat.id !== current.activeId || chat.turns.length > 0),
      ],
      activeId: created.id,
      blankDomain: null,
    }));
  },

  keep: (state) => {
    const { chats, activeId } = get();
    const chat = chats.find((c) => c.id === activeId);
    const now = Date.now();
    const turn = turnOf(state, now);
    if (!chat || !turn) return;
    const updated = withTurn(chat, turn, now);
    set({ chats: chats.map((c) => (c.id === updated.id ? updated : c)) });
    void chatIpc.save(updated).catch(() => {});
  },

  remove: async (id) => {
    // Rust deletes first: if it fails, the chat stays in the list and the user can try again.
    await chatIpc.remove(id);
    const removed = get().chats.find((chat) => chat.id === id);
    set((current) => ({
      chats: current.chats.filter((chat) => chat.id !== id),
      ...(current.activeId === id ? { activeId: null, blankDomain: removed?.domain ?? null } : {}),
    }));
  },

  clear: async () => {
    await chatIpc.clear();
    set({ chats: [], activeId: null, blankDomain: null });
  },

  forget: () => set({ chats: [], loaded: false, activeId: null, blankDomain: null }),
}));

/** The chat the next request continues. */
export const selectActiveChat = (store: ChatStore): ChatSession | undefined =>
  store.chats.find((chat) => chat.id === store.activeId);
