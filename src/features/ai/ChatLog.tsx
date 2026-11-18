import { useT } from "../../i18n/useT";
import type { Translate } from "../../i18n/translate";
import { ActivityList } from "./ActivityList";
import { AnswerView } from "./AnswerView";
import { AssistantBubble, RequestBubble } from "./ChatBubbles";
import { restoreError } from "./errors";
import type { ChatTurn, Proposal } from "./ipc";
import { ProposalDetails } from "./ProposalDetails";

/**
 * The turns of a chat that are over, as they ended. `liveTurnId` is the request still in flight:
 * it is drawn by the assistant panel, with its buttons, not here. A saved turn that is still
 * waiting for an answer was left behind: its preview is gone from the page.
 */
export function ChatLog({
  turns,
  liveTurnId,
}: {
  turns: readonly ChatTurn[];
  liveTurnId: string | null;
}) {
  return (
    <>
      {turns
        .filter((turn) => turn.id !== liveTurnId)
        .map((turn) => (
          <SavedTurn key={turn.id} turn={turn} />
        ))}
    </>
  );
}

function resultLine(
  status: "proposed" | "accepted" | "rejected",
  proposal: Proposal,
  t: Translate,
) {
  if (status === "accepted") {
    return proposal.kind === "existingOption"
      ? t("assistant.turnedOn", { option: proposal.option.label })
      : t("assistant.addedSwitch", { option: proposal.option.label });
  }
  return status === "rejected" ? t("assistant.nothingChanged") : t("assistant.notApplied");
}

function SavedTurn({ turn }: { turn: ChatTurn }) {
  const t = useT();
  const { outcome } = turn;
  const failure = outcome.status === "failed" ? restoreError(outcome.kind, outcome.text) : null;

  return (
    <div className="flex flex-col gap-2.5">
      <RequestBubble request={turn.request} />
      {turn.steps.length > 0 && (
        <details className="ps-1 text-xs text-paper/55">
          <summary className="cursor-pointer py-0.5">{t("assistant.stepsToggle")}</summary>
          <div className="pt-1.5">
            <ActivityList steps={turn.steps} provider={turn.provider} />
          </div>
        </details>
      )}
      {outcome.status === "failed" ? (
        <p role="alert" className="px-2 text-sm text-paper/80">
          {failure?.key ? t(failure.key) : failure?.text}
        </p>
      ) : outcome.status === "answered" ? (
        <AnswerView answer={outcome.answer} />
      ) : (
        <>
          <AssistantBubble>{outcome.proposal.summary}</AssistantBubble>
          <ProposalDetails proposal={outcome.proposal} />
          <p className="px-2 text-xs text-paper/60">
            {resultLine(outcome.status, outcome.proposal, t)}
          </p>
        </>
      )}
    </div>
  );
}
