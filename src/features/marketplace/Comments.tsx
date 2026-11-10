import { useCallback, useEffect, useState } from "react";
import { appError, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { ProIcon } from "../../shared/icons";
import { useEntitlementStore } from "../paywall/store";
import { Group, primaryBlockButton, quietBlockButton } from "../settings/ui";
import { marketplace, type MarketComment } from "./ipc";
import { MAX_COMMENT_CHARS, commentToSend, withoutBlocked } from "./logic";

/** What people said about a recipe. Everyone reads; only Pro posts, and only in the app. */
export function CommentsSection({
  recipeId,
  onManageBlocked,
}: {
  recipeId: string;
  onManageBlocked: () => void;
}) {
  const t = useT();
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const openSheet = useApp((s) => s.openSheet);
  const [comments, setComments] = useState<MarketComment[] | null>(null);
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [reported, setReported] = useState<ReadonlySet<string>>(new Set());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      marketplace
        .comments(recipeId)
        .then(setComments)
        .catch((failure: unknown) => {
          setComments([]);
          setError(appError(failure));
        }),
    [recipeId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(appError(failure));
    } finally {
      setBusy(false);
    }
  };

  const post = () => {
    const body = commentToSend(text);
    if (body === null) return;
    void attempt(async () => {
      await marketplace.postComment(recipeId, body);
      setText("");
      await load();
    });
  };

  const remove = (comment: MarketComment) =>
    void attempt(async () => {
      await marketplace.deleteComment(comment.id);
      await load();
    });

  const report = (comment: MarketComment) =>
    void attempt(async () => {
      await marketplace.reportComment(comment.id);
      setReported((current) => new Set(current).add(comment.id));
    });

  const block = (comment: MarketComment) =>
    void attempt(async () => {
      await marketplace.blockCommenter(comment.commenter);
      setBlocked((current) => new Set(current).add(comment.commenter));
    });

  const shown = comments ? withoutBlocked(comments, blocked) : null;
  const small = "text-sm font-medium text-accent disabled:opacity-50";

  return (
    <section className="flex flex-col gap-3">
      <p className="px-1 text-[13px] font-medium text-paper/60">{t("market.comments")}</p>
      {shown === null && (
        <p className="px-1 text-sm text-paper/55">{t("market.comments.loading")}</p>
      )}
      {shown?.length === 0 && (
        <p className="px-1 text-sm text-paper/55">{t("market.comments.none")}</p>
      )}
      {shown && shown.length > 0 && (
        <Group>
          {shown.map((comment) => (
            <div key={comment.id} className="flex flex-col gap-1.5 px-4 py-3">
              <p className="text-xs text-paper/50">
                {comment.mine ? t("market.comments.you") : `#${comment.commenter}`}
                {" · "}
                {new Date(comment.createdAt * 1000).toLocaleDateString()}
              </p>
              <p className="text-sm leading-snug break-words whitespace-pre-wrap">{comment.text}</p>
              <div className="flex flex-wrap gap-4">
                {comment.mine ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(comment)}
                    className={small}
                  >
                    {t("common.delete")}
                  </button>
                ) : (
                  <>
                    {reported.has(comment.id) ? (
                      <span className="text-sm text-paper/55">{t("market.comments.reported")}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => report(comment)}
                        className={small}
                      >
                        {t("market.comments.report")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => block(comment)}
                      className={small}
                    >
                      {t("market.comments.block")}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </Group>
      )}
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
      {isPro ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={t("market.comments.write")}
            placeholder={t("market.comments.write")}
            className="min-h-20 w-full rounded-2xl border border-hair bg-paper/[0.04] px-4 py-3 text-base"
          />
          <p className="px-1 text-[13px] leading-snug text-paper/50">
            {t("market.comments.rules")} {[...text].length} / {MAX_COMMENT_CHARS}
          </p>
          <button
            type="button"
            disabled={busy || commentToSend(text) === null}
            onClick={post}
            className={primaryBlockButton}
          >
            {t("market.comments.post")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => openSheet("paywall")}
          className="flex items-center gap-3 rounded-2xl border border-hair bg-paper/[0.04] px-4 py-3.5 text-start active:bg-paper/[0.08]"
        >
          <span className="pro-badge grid size-6 shrink-0 place-items-center rounded-full">
            <ProIcon size={12} />
          </span>
          <span className="text-sm leading-snug text-paper/70">
            {t("market.comments.proPrompt")}
          </span>
        </button>
      )}
      <button type="button" onClick={onManageBlocked} className={quietBlockButton}>
        {t("market.comments.blocked")}
      </button>
    </section>
  );
}

/** The people whose comments are hidden on this device, each with a way back. */
export function BlockedView() {
  const t = useT();
  const [blocked, setBlocked] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    marketplace
      .blocked()
      .then(setBlocked)
      .catch((failure: unknown) => {
        setBlocked([]);
        setError(appError(failure));
      });
  }, []);

  const unblock = async (commenter: string) => {
    setError(null);
    try {
      await marketplace.unblockCommenter(commenter);
      setBlocked((current) => current?.filter((id) => id !== commenter) ?? null);
    } catch (failure) {
      setError(appError(failure));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-[13px] leading-snug text-paper/50">
        {t("market.comments.blockedNote")}
      </p>
      {blocked?.length === 0 && (
        <p className="px-1 text-sm text-paper/55">{t("market.comments.blockedNone")}</p>
      )}
      {blocked && blocked.length > 0 && (
        <Group>
          {blocked.map((commenter) => (
            <div key={commenter} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate font-mono text-sm">#{commenter}</span>
              <button
                type="button"
                onClick={() => void unblock(commenter)}
                className="text-sm font-medium text-accent"
              >
                {t("market.comments.unblock")}
              </button>
            </div>
          ))}
        </Group>
      )}
      {error && <p className="px-1 text-sm text-paper/70">{error}</p>}
    </div>
  );
}
