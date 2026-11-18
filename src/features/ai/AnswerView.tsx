import { useApp } from "../../app/store";
import { AssistantBubble } from "./ChatBubbles";
import type { Answer } from "./ipc";

/** What the assistant said to a question, with the pages it points to as buttons that open them. */
export function AnswerView({ answer }: { answer: Answer }) {
  const openAddress = useApp((s) => s.openAddress);
  return (
    <>
      <AssistantBubble>{answer.text}</AssistantBubble>
      {answer.links.length > 0 && (
        <ul className="flex flex-wrap gap-2 px-1">
          {answer.links.map((link) => (
            <li key={link.url} className="max-w-full">
              <button
                type="button"
                title={link.url}
                onClick={() => openAddress(link.url)}
                className="max-w-full truncate rounded-full border border-hair px-3.5 py-2 text-sm font-medium text-accent active:bg-paper/[0.08]"
              >
                {link.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
