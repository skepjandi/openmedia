import { useCallback, useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { Screen } from "../../shared/Screen";
import { Spinner } from "../../shared/Spinner";
import { GuideLink } from "../guides/GuideLink";
import { field, primaryBlockButton, quietBlockButton } from "../settings/ui";
import { share } from "./ipc";
import {
  MAX_SUMMARY_CHARS,
  errorKey,
  suggestedSummary,
  summaryToSend,
  useShare,
} from "./shareFlow";

/** The guided "share with everyone" page, opened from Settings. */
export function ShareRecipeScreen() {
  const open = useApp((s) => s.sheet === "share-recipe");
  return open ? <ShareRecipeBody /> : null;
}

function ShareRecipeBody() {
  const closeSheet = useApp((s) => s.closeSheet);
  const t = useT();

  return (
    <Screen title={t("share.github.title")} closeLabel={t("common.back")} onClose={closeSheet} back>
      <div className="flex flex-col items-start gap-2">
        <GithubFlow />
        <GuideLink slug="your-recipe" labelKey="guides.makeRecipe" />
      </div>
    </Screen>
  );
}

function GithubFlow() {
  const sites = useApp((s) => s.sites);
  const own = sites.filter((site) => site.origin === "user" || site.origin === "ai");
  const t = useT();
  const { flow, begin, cancel, reset } = useShare();
  const account = useShareAccount(flow.phase === "done");
  const [recipeId, setRecipeId] = useState(own[0]?.recipeId ?? "");
  const [summary, setSummary] = useState(() => suggestedSummary(own[0]?.name ?? ""));

  const pick = (id: string) => {
    const name = (site: { recipeId: string; name: string } | undefined) => site?.name ?? "";
    const previous = suggestedSummary(name(own.find((site) => site.recipeId === recipeId)));
    setRecipeId(id);
    // A description the person has not touched follows the recipe they pick.
    if (summary === previous) {
      setSummary(suggestedSummary(name(own.find((site) => site.recipeId === id))));
    }
  };

  if (own.length === 0) {
    return (
      <section className="flex flex-col gap-4">
        <p className="px-1 text-sm text-paper/55">{t("share.none")}</p>
      </section>
    );
  }

  const form = flow.phase === "idle" || flow.phase === "refused";
  const ready = summaryToSend(summary) !== null && recipeId !== "";

  return (
    <section className="mx-auto flex w-full max-w-xl flex-col gap-5">
      {form && (
        <>
          <label className="flex flex-col gap-2 text-sm font-medium text-paper/80">
            {t("share.github.recipe")}
            <select
              value={recipeId}
              onChange={(event) => pick(event.target.value)}
              className={field}
            >
              {own.map((site) => (
                <option key={site.recipeId} value={site.recipeId}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium text-paper/80">
            {t("share.github.summary")}
            <input
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              maxLength={MAX_SUMMARY_CHARS}
              className={field}
            />
            <span className="self-end text-xs text-paper/45">
              {t("share.github.count", { count: [...summary].length })}
            </span>
          </label>
          {flow.phase === "refused" && (
            <p role="alert" className="px-1 text-sm text-paper/70">
              {flow.message}
            </p>
          )}
          <button
            type="button"
            disabled={!ready}
            onClick={() => begin(recipeId, summaryToSend(summary) ?? "")}
            className={primaryBlockButton}
          >
            {t(account.login ? "share.github.send" : "share.github.continue")}
          </button>
          {account.login && (
            <AccountRow login={account.login} onSignOut={() => void account.signOut()} />
          )}
          <ul className="flex flex-col gap-2 rounded-2xl border border-hair bg-paper/[0.035] p-4 text-[13px] leading-relaxed text-paper/60">
            {!account.login && (
              <li className="border-s-2 border-accent/60 ps-3">{t("share.github.needAccount")}</li>
            )}
            <li className="border-s-2 border-accent/60 ps-3">{t("share.github.whatSent")}</li>
            <li className="border-s-2 border-accent/60 ps-3">{t("share.github.afterReview")}</li>
          </ul>
        </>
      )}
      {flow.phase === "starting" && <Spinner className="px-1" label={t("share.github.working")} />}
      {flow.phase === "polling" && (
        <div className="flex flex-col items-start gap-4 px-1">
          {flow.status?.state === "working" ? (
            <Spinner label={t("share.github.working")} />
          ) : (
            <>
              <p className="text-base leading-snug">{t("share.github.waiting")}</p>
              <Spinner />
              <button type="button" onClick={cancel} className={quietBlockButton}>
                {t("common.cancel")}
              </button>
            </>
          )}
        </div>
      )}
      {flow.phase === "done" && (
        <ThanksStep
          id={flow.id}
          hasLink={flow.prUrl !== null}
          login={flow.login ?? account.login}
          onDone={reset}
        />
      )}
      {(flow.phase === "failed" || flow.phase === "timeout") && (
        <div className="flex flex-col items-start gap-4 px-1">
          <p role="alert" className="text-base leading-snug">
            {flow.phase === "failed" && flow.errorCode === "invalid" && flow.error
              ? flow.error
              : t(
                  flow.phase === "timeout"
                    ? "share.github.error.timeout"
                    : errorKey(flow.errorCode),
                )}
          </p>
          <button type="button" onClick={reset} className={primaryBlockButton}>
            {t("share.github.tryAgain")}
          </button>
        </div>
      )}
    </section>
  );
}

/** The GitHub account this device shares as, kept in Rust. Looked up again after a share ends. */
function useShareAccount(refreshWhen: boolean) {
  const [login, setLogin] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    share
      .account()
      .then((found) => {
        if (!stale) setLogin(found);
      })
      .catch(() => {
        if (!stale) setLogin(null);
      });
    return () => {
      stale = true;
    };
  }, [refreshWhen]);

  const signOut = useCallback(async () => {
    try {
      await share.signOut();
    } finally {
      setLogin(null);
    }
  }, []);

  return { login, signOut };
}

function AccountRow({ login, onSignOut }: { login: string; onSignOut: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-sm text-paper/70">
      <span>{t("share.github.signedInAs", { login })}</span>
      <button type="button" onClick={onSignOut} className="py-1 font-medium text-accent">
        {t("share.github.signOut")}
      </button>
    </div>
  );
}

function ThanksStep({
  id,
  hasLink,
  login,
  onDone,
}: {
  id: string;
  hasLink: boolean;
  login: string | null;
  onDone: () => void;
}) {
  const t = useT();
  const [openError, setOpenError] = useState<string | null>(null);

  return (
    <div role="status" className="flex flex-col items-stretch gap-4 px-1">
      <p className="text-lg leading-snug font-medium">{t("share.github.thanks")}</p>
      {login && <p className="text-sm text-paper/60">{t("share.github.signedInAs", { login })}</p>}
      {hasLink && (
        <button
          type="button"
          onClick={() => {
            setOpenError(null);
            share.open(id).catch((failure: unknown) => setOpenError(appError(failure)));
          }}
          className="self-start py-1 text-sm font-medium text-accent"
        >
          {t("share.github.see")}
        </button>
      )}
      {openError && <p className="text-sm text-paper/70">{openError}</p>}
      <button type="button" onClick={onDone} className={primaryBlockButton}>
        {t("common.done")}
      </button>
    </div>
  );
}
