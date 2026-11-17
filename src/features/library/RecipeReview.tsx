import { useState } from "react";
import { useT } from "../../i18n/useT";
import { CodeBlock, Chip } from "../../shared/CodeBlock";
import { Group, GroupLabel } from "../settings/ui";
import { Markdown } from "./Markdown";
import type { RecipePreview, RulePreview } from "./ipc";

/**
 * Everything a recipe would do, rule by rule, from what Rust validated. Nothing here is the
 * sender's own formatting: the strings are plain text and are shown as text, never as markup.
 */
export function RecipeReview({ preview }: { preview: RecipePreview }) {
  const t = useT();

  return (
    <div className="flex flex-col gap-5">
      <div className="px-1">
        <p className="text-sm text-paper/55">
          {t("library.review.version", { version: preview.version })}
          {preview.author ? ` · ${t("library.by", { author: preview.author })}` : ""}
          {preview.runsCode && (
            <>
              {" "}
              <Chip>{t("library.review.runsCode")}</Chip>
            </>
          )}
        </p>
        {preview.replaces && (
          <p className="mt-1 text-sm text-paper/55">
            {t("library.review.replaces", { version: preview.replaces })}
          </p>
        )}
        {preview.notes && <Notes source={preview.notes} />}
      </div>
      <div>
        <GroupLabel>{t("library.review.sites")}</GroupLabel>
        <Group>
          {preview.sites.map((site) => (
            <code key={site} className="block px-4 py-2.5 text-sm break-all text-paper/80">
              {site}
            </code>
          ))}
        </Group>
      </div>
      {preview.tabs && preview.tabs.length > 0 && (
        <div>
          <GroupLabel>{t("library.review.pages")}</GroupLabel>
          <Group>
            {preview.tabs.map((tab) => (
              <div key={tab.url} className="px-4 py-3">
                <span className="block text-base">{tab.label}</span>
                <span className="mt-0.5 block text-sm break-all text-paper/55">{tab.host}</span>
              </div>
            ))}
          </Group>
        </div>
      )}
      {preview.options.length > 0 && (
        <div>
          <GroupLabel>{t("library.review.options")}</GroupLabel>
          <Group>
            {preview.options.map((option) => (
              <div key={option.label} className="px-4 py-3">
                <span className="block text-base">{option.label}</span>
                <span className="mt-0.5 block text-sm leading-snug text-paper/55">
                  {option.description}
                </span>
                {option.choices.length > 0 && (
                  <span className="mt-1 block text-sm text-paper/70">
                    {option.choices.join(" · ")}
                  </span>
                )}
              </div>
            ))}
          </Group>
        </div>
      )}
      <div>
        <GroupLabel>{t("library.review.rules")}</GroupLabel>
        <Group>
          {preview.rules.map((rule) => (
            <RuleRow key={`${rule.kind}:${rule.selector}:${rule.label}`} rule={rule} />
          ))}
        </Group>
      </div>
    </div>
  );
}

/** Notes are Markdown and can run long: a faded preview shows first, a tap shows the rest. */
function Notes({ source }: { source: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  return (
    <div className="mt-3">
      <div
        ref={(element) => {
          if (element && !expanded) setOverflows(element.scrollHeight > element.clientHeight + 1);
        }}
        className={
          expanded ? "" : "max-h-40 overflow-hidden mask-[linear-gradient(black_65%,transparent)]"
        }
      >
        <Markdown source={source} />
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 flex w-full justify-center py-1 text-paper/55"
        >
          <span aria-hidden="true" className={expanded ? "rotate-180" : ""}>
            ⌄
          </span>
        </button>
      )}
    </div>
  );
}

const REVIEW_VERBS = {
  hide: "library.review.hides",
  css: "library.review.restyles",
  redirect: "library.review.redirects",
} as const;

function RuleRow({ rule }: { rule: RulePreview }) {
  const t = useT();
  if (rule.kind === "script") return <ScriptRuleRow rule={rule} />;
  const declarations = Object.entries(rule.declarations);

  return (
    <div className="px-4 py-3">
      <span className="block text-base">
        <span className="text-paper/55">{t(REVIEW_VERBS[rule.kind])}</span> {rule.label}
      </span>
      <code className="mt-1 block text-[13px] leading-snug break-all text-paper/70">
        {rule.selector}
      </code>
      {declarations.length > 0 && (
        <code className="mt-1 block text-[13px] leading-snug break-all text-paper/70">
          {declarations.map(([property, value]) => `${property}: ${value}`).join("; ")}
        </code>
      )}
    </div>
  );
}

/** A script rule: its label, a "Runs code" chip, and the code itself, collapsed, as text. */
function ScriptRuleRow({ rule }: { rule: RulePreview }) {
  const t = useT();
  return (
    <div className="px-4 py-3">
      <span className="flex items-baseline justify-between gap-3 text-base">
        <span className="min-w-0">{rule.label}</span>
        <Chip>{t("library.review.runsCode")}</Chip>
      </span>
      {rule.code != null && (
        <CodeBlock
          code={rule.code}
          showLabel={t("library.review.showCode")}
          hideLabel={t("library.review.hideCode")}
        />
      )}
      <p className="mt-1.5 text-xs leading-snug text-paper/55">{t("library.review.codeNote")}</p>
    </div>
  );
}
