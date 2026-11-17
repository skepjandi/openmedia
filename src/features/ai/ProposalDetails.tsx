import { useT } from "../../i18n/useT";
import { Chip, CodeBlock } from "../../shared/CodeBlock";
import type { Proposal, ProposalRule } from "./ipc";
import { POWER_KEY, groupPowers, limitLines } from "./scriptPowers";

/** The switch an answer would add or turn on, with the rules it hides and what each matched. */
export function ProposalDetails({ proposal }: { proposal: Proposal }) {
  const t = useT();
  return (
    <div className="rounded-xl border border-hair bg-paper/[0.05] px-3 py-2.5">
      {proposal.kind === "existingOption" && (
        <p className="text-xs font-medium text-accent">{t("assistant.switchExists")}</p>
      )}
      <p className="text-sm font-medium text-paper">{proposal.option.label}</p>
      {proposal.option.description && (
        <p className="text-xs leading-snug text-paper/60">{proposal.option.description}</p>
      )}
      <p className="mt-1 text-[11px] tracking-wide text-paper/45 uppercase">
        {proposal.option.group === "annoyance"
          ? t("recipes.groupAnnoyance")
          : t("recipes.groupContent")}{" "}
        · {proposal.recipeName}
      </p>
      {proposal.rules.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5 border-t border-hair pt-2">
          {proposal.rules.map((rule, index) => (
            <RuleItem key={index} rule={rule} />
          ))}
        </ul>
      )}
      {proposal.runsCode && <ScriptDisclosure proposal={proposal} />}
    </div>
  );
}

function RuleItem({ rule }: { rule: ProposalRule }) {
  const t = useT();
  if (rule.kind === "script") {
    return (
      <li className="text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-paper/80">{rule.label}</span>
          <Chip>{t("assistant.script.runs")}</Chip>
        </div>
        {rule.code != null && (
          <CodeBlock
            code={rule.code}
            showLabel={t("assistant.script.show")}
            hideLabel={t("assistant.script.hide")}
          />
        )}
      </li>
    );
  }
  if (rule.kind === "dark") {
    return (
      <li className="text-xs">
        <span className="block min-w-0 truncate text-paper/80">{rule.label}</span>
        {rule.selector !== "" && (
          <code className="mt-0.5 block break-all text-paper/55">{rule.selector}</code>
        )}
      </li>
    );
  }
  return (
    <li className="flex items-baseline justify-between gap-3 text-xs">
      <span className="min-w-0 truncate text-paper/80">{rule.label}</span>
      <span className={`shrink-0 ${rule.matches > 0 ? "text-paper/55" : "text-accent"}`}>
        {t("assistant.matched", { count: Math.max(rule.matches, 0) })}
      </span>
    </li>
  );
}

/**
 * The informed-consent surface for a proposal that runs code: when it runs, what it can do
 * (always visible, never behind a tap) and whether it could be shared.
 */
function ScriptDisclosure({ proposal }: { proposal: Proposal }) {
  const t = useT();
  const groups = groupPowers(proposal.rules.flatMap((rule) => rule.powers));
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-hair pt-2 text-xs leading-snug">
      <p className="text-paper/70">{t("assistant.script.afterAccept")}</p>
      {groups.length > 0 && (
        <div>
          <p className="font-medium text-paper/80">{t("assistant.script.powers")}</p>
          <ul className="mt-1 flex flex-col gap-1">
            {groups.map(({ topic, lines }) => {
              const { shown, more } = limitLines(lines);
              return (
                <li key={topic} className="text-paper/70">
                  {t(POWER_KEY[topic])}{" "}
                  <span className="text-paper/45">
                    ({shown.map((line) => t("assistant.script.line", { line })).join(", ")}
                    {more ? ", …" : ""})
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-paper/55">
        {t(proposal.publishable ? "assistant.script.shareable" : "assistant.script.notShareable")}
      </p>
    </div>
  );
}
