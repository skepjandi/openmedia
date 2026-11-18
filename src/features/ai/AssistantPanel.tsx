import type { ReactNode } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { ActivityList } from "./ActivityList";
import { AnswerView } from "./AnswerView";
import { AssistantBubble, RequestBubble } from "./ChatBubbles";
import type { AssistantState } from "./flow";
import { ProposalDetails } from "./ProposalDetails";
import type { Proposal } from "./ipc";

const primary =
  "rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent disabled:opacity-40";
const quiet =
  "rounded-full border border-hair px-4 py-2.5 text-sm font-medium text-paper/85 disabled:opacity-40";

type Live = Exclude<AssistantState, { status: "idle" }>;

/**
 * The request in flight, as a turn of the chat: what the user asked, what the assistant is doing
 * step by step, and the card that needs the user. `compact` leaves out the asking and the steps,
 * for the dock, which sits over the page.
 */
export function AssistantPanel({
  state,
  compact = false,
}: {
  state: AssistantState;
  compact?: boolean;
}) {
  if (state.status === "idle") return null;
  return (
    <div className="flex flex-col gap-2.5">
      {!compact && (
        <>
          <RequestBubble request={state.request} />
          <ActivityList steps={state.steps} provider={state.provider} />
        </>
      )}
      <LiveBody state={state} compact={compact} />
    </div>
  );
}

function LiveBody({ state, compact }: { state: Live; compact: boolean }) {
  const cancel = useApp((s) => s.cancelAssistant);
  const confirmSend = useApp((s) => s.confirmSend);
  const retry = useApp((s) => s.retryAssistant);
  const openSheet = useApp((s) => s.openSheet);
  const t = useT();

  switch (state.status) {
    case "preparing":
    case "sending":
      return (
        <Body busy>
          <Actions>
            <button type="button" className={quiet} onClick={() => cancel()}>
              {t("common.cancel")}
            </button>
          </Actions>
        </Body>
      );
    case "preview": {
      const { prepared } = state;
      return (
        <Body>
          <p className="text-sm font-medium text-paper">
            {t("assistant.payloadIntro", { provider: prepared.providerName })}
            {prepared.model ? ` (${prepared.model})` : ""}
          </p>
          <p className="text-xs text-paper/55">
            {t("assistant.payloadNote", { count: prepared.tokenEstimate.toLocaleString() })}
          </p>
          <pre
            aria-label={t("assistant.payloadLabel")}
            tabIndex={0}
            className="max-h-[36vh] overflow-auto rounded-xl border border-hair bg-paper/[0.05] p-3 text-[11px] leading-snug break-words whitespace-pre-wrap text-paper/80 select-text"
          >
            {prepared.payload}
          </pre>
          <Actions>
            <button type="button" className={quiet} onClick={() => cancel()}>
              {t("common.cancel")}
            </button>
            <button type="button" className={primary} onClick={() => void confirmSend()}>
              {t("assistant.send")}
            </button>
          </Actions>
        </Body>
      );
    }
    case "proposal":
      return <ProposalCard proposal={state.proposal} request={compact ? state.request : null} />;
    case "accepting":
      return (
        <Body busy>
          <p>{t("assistant.saving")}</p>
        </Body>
      );
    case "accepted":
      return (
        <Body>
          <AssistantBubble>{state.proposal.summary}</AssistantBubble>
          <p className="text-sm font-medium text-paper">
            {state.proposal.kind === "existingOption"
              ? t("assistant.turnedOn", { option: state.proposal.option.label })
              : t("assistant.addedSwitch", { option: state.proposal.option.label })}
          </p>
          <p className="text-xs text-paper/55">
            {t("assistant.findInSettings", { recipe: state.proposal.recipeName })}
          </p>
          <Actions>
            <button type="button" className={quiet} onClick={() => cancel()}>
              {t("common.done")}
            </button>
            <button
              type="button"
              className={primary}
              onClick={() => {
                openSheet("settings");
                cancel();
              }}
            >
              {t("assistant.openInSettings")}
            </button>
          </Actions>
        </Body>
      );
    case "answered":
      return (
        <Body>
          <AnswerView answer={state.answer} />
          <Actions>
            <button type="button" className={primary} onClick={() => cancel()}>
              {t("common.done")}
            </button>
          </Actions>
        </Body>
      );
    case "rejected":
      return (
        <Body>
          <p>{t("assistant.nothingChanged")}</p>
          <Actions>
            <button type="button" className={quiet} onClick={() => cancel()}>
              {t("common.done")}
            </button>
            <button type="button" className={primary} onClick={() => cancel(true)}>
              {t("assistant.askAgain")}
            </button>
          </Actions>
        </Body>
      );
    case "error":
      return (
        <Body alert>
          <p className="text-sm text-paper">
            {state.error.key ? t(state.error.key) : state.error.text}
          </p>
          <Actions>
            {state.error.kind === "missingKey" && (
              <button type="button" className={quiet} onClick={() => openSheet("settings")}>
                {t("common.openSettings")}
              </button>
            )}
            <button type="button" className={quiet} onClick={() => cancel(true)}>
              {t("assistant.editRequest")}
            </button>
            {state.error.kind !== "noPage" && (
              <button type="button" className={primary} onClick={() => void retry()}>
                {t("common.retry")}
              </button>
            )}
          </Actions>
        </Body>
      );
  }
}

/** `request` is shown as a quote when the card stands alone, without the chat above it. */
function ProposalCard({ proposal, request }: { proposal: Proposal; request: string | null }) {
  const accept = useApp((s) => s.acceptProposal);
  const reject = useApp((s) => s.rejectProposal);
  const cancel = useApp((s) => s.cancelAssistant);
  const t = useT();
  const existing = proposal.kind === "existingOption";

  return (
    <Body>
      {request !== null && (
        <p className="truncate text-xs text-paper/45">{t("assistant.requestQuote", { request })}</p>
      )}
      <AssistantBubble>{proposal.summary}</AssistantBubble>
      <ProposalDetails proposal={proposal} />
      {proposal.unmatched > 0 && (
        <p role="alert" className="text-xs leading-snug text-accent">
          {t("assistant.unmatched", { count: proposal.unmatched })} {t("assistant.unmatchedHint")}
        </p>
      )}
      <p className="text-xs text-paper/50">
        {existing ? t("assistant.resultLive") : t("assistant.resultPreview")}
      </p>
      <Actions>
        <button type="button" className={quiet} onClick={() => cancel(true)}>
          {t("assistant.askAgain")}
        </button>
        <button type="button" className={quiet} onClick={() => void reject()}>
          {t("assistant.reject")}
        </button>
        <button type="button" className={primary} onClick={() => void accept()}>
          {t("assistant.accept")}
        </button>
      </Actions>
    </Body>
  );
}

function Body({ children, busy, alert }: { children: ReactNode; busy?: boolean; alert?: boolean }) {
  return (
    <div
      role={alert ? "alert" : "status"}
      aria-live={alert ? "assertive" : "polite"}
      aria-busy={busy}
      className="flex flex-col gap-2.5 px-2 pt-1 text-sm text-paper/80"
    >
      {children}
    </div>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{children}</div>;
}
