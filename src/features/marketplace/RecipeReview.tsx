import { useState } from "react";
import { useT } from "../../i18n/useT";
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
          {t("market.review.version", { version: preview.version })}
          {preview.author ? ` · ${t("market.by", { author: preview.author })}` : ""}
        </p>
        {preview.replaces && (
          <p className="mt-1 text-sm text-paper/55">
            {t("market.review.replaces", { version: preview.replaces })}
          </p>
        )}
        {preview.notes && <Notes source={preview.notes} />}
      </div>
      <div>
        <GroupLabel>{t("market.review.sites")}</GroupLabel>
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
          <GroupLabel>{t("market.review.pages")}</GroupLabel>
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
          <GroupLabel>{t("market.review.options")}</GroupLabel>
          <Group>
            {preview.options.map((option) => (
              <div key={option.label} className="px-4 py-3">
                <span className="block text-base">{option.label}</span>
                <span className="mt-0.5 block text-sm leading-snug text-paper/55">
                  {option.description}
                </span>
              </div>
            ))}
          </Group>
        </div>
      )}
      <div>
        <GroupLabel>{t("market.review.rules")}</GroupLabel>
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

function RuleRow({ rule }: { rule: RulePreview }) {
  const t = useT();
  const declarations = Object.entries(rule.declarations);

  return (
    <div className="px-4 py-3">
      <span className="block text-base">
        <span className="text-paper/55">
          {t(rule.kind === "hide" ? "market.review.hides" : "market.review.restyles")}
        </span>{" "}
        {rule.label}
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
