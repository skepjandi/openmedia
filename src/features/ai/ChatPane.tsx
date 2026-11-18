import { useEffect, useRef } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { ChatsIcon, HistoryIcon, PlusIcon } from "../../shared/icons";
import { AssistantPanel } from "./AssistantPanel";
import { savedFor } from "./chat";
import { ChatHistory } from "./ChatHistory";
import { ChatLog } from "./ChatLog";
import { selectActiveChat, useChat } from "./chatStore";

const tool =
  "grid size-9 place-items-center rounded-full text-paper/70 disabled:opacity-25 aria-pressed:bg-paper/[0.1] aria-pressed:text-paper";

/**
 * The assistant as a chat: the site and recipe it is about, the turns so far, and the request
 * in flight. History and New chat sit in the header while nothing is running.
 */
export function ChatPane({
  domain,
  historyOpen,
  onToggleHistory,
  onNewChat,
}: {
  /** The site on screen; `null` when the chat in flight outlived it. */
  domain: string | null;
  historyOpen: boolean;
  onToggleHistory: () => void;
  onNewChat: () => void;
}) {
  const assistant = useApp((s) => s.assistant);
  const chats = useChat((s) => s.chats);
  const activeId = useChat((s) => s.activeId);
  const active = useChat(selectActiveChat);
  const resume = useChat((s) => s.resume);
  const remove = useChat((s) => s.remove);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);

  const idle = assistant.status === "idle";
  const liveTurnId = idle ? null : assistant.turnId;
  const site = active?.domain ?? domain ?? "";
  const turnCount = active?.turns.length ?? 0;
  const stepCount = idle ? 0 : assistant.steps.length;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turnCount, stepCount, assistant.status, historyOpen]);

  const showHistory = historyOpen && idle;
  const empty = idle && turnCount === 0;

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-paper/70">
            {t("assistant.chatAbout", { site })}
          </p>
          {active?.recipeName && (
            <p className="truncate text-[11px] text-paper/45">
              {t("assistant.chatRecipe", { recipe: active.recipeName })}
            </p>
          )}
        </div>
        {idle && (
          <div className="flex shrink-0">
            <button
              type="button"
              aria-label={t("assistant.allChats")}
              className={tool}
              onClick={() => openSheet("chats")}
            >
              <ChatsIcon />
            </button>
            <button
              type="button"
              aria-label={t("assistant.chatHistory")}
              aria-pressed={historyOpen}
              className={tool}
              onClick={onToggleHistory}
            >
              <HistoryIcon />
            </button>
            <button
              type="button"
              aria-label={t("assistant.newChat")}
              disabled={turnCount === 0}
              className={tool}
              onClick={onNewChat}
            >
              <PlusIcon />
            </button>
          </div>
        )}
      </div>
      <div
        ref={scroller}
        className={`flex flex-col gap-4 overflow-y-auto ${idle ? "max-h-[45vh]" : "max-h-[60vh]"}`}
      >
        {showHistory ? (
          <ChatHistory
            chats={savedFor(chats, active?.domain ?? domain ?? "")}
            activeId={activeId}
            onOpen={(id) => {
              resume(id);
              onToggleHistory();
            }}
            onDelete={(id) => void remove(id).catch(() => {})}
          />
        ) : (
          <>
            <ChatLog turns={active?.turns ?? []} liveTurnId={liveTurnId} />
            <AssistantPanel state={assistant} />
            {empty && (
              <p className="px-2 py-3 text-center text-sm text-paper/55">
                {t("assistant.chatEmpty")}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
