import { useEffect } from "react";
import { selectLocale, useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { displayHost } from "../../shared/favorites";
import { ChatsIcon, DownIcon } from "../../shared/icons";
import type { Favorite } from "../../shared/ipc";
import { Screen } from "../../shared/Screen";
import { siteOf } from "../../shared/site";
import { SiteTile } from "../../shared/SiteTile";
import { useIconForUrl } from "../../shared/siteIcons";
import { useEntitlementStore } from "../paywall/store";
import { RECENT_CHATS, recentChats, savedFor } from "./chat";
import { useChat } from "./chatStore";
import type { ChatSession } from "./ipc";

const NO_HISTORY: string[] = [];
const NO_FAVORITES: Favorite[] = [];

/**
 * Every saved chat in one place: the latest across all sites on top, then a dropdown for each
 * favorite and each history address with the chats of that site inside.
 */
export function ChatsSheet() {
  const open = useApp((s) => s.sheet === "chats");
  const closeSheet = useApp((s) => s.closeSheet);
  const history = useApp((s) => s.state?.history) ?? NO_HISTORY;
  const favorites = useApp((s) => s.state?.favorites) ?? NO_FAVORITES;
  const isPro = useEntitlementStore((s) => s.status === "pro");
  const chats = useChat((s) => s.chats);
  const loadChats = useChat((s) => s.load);
  const t = useT();

  useEffect(() => {
    if (open && isPro) void loadChats();
  }, [open, isPro, loadChats]);

  if (!open) return null;

  const recent = recentChats(chats, RECENT_CHATS);

  return (
    <Screen
      title={t("chats.title")}
      subtitle={t("chats.subtitle")}
      closeLabel={t("chats.close")}
      onClose={closeSheet}
    >
      {recent.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-8 pt-10 pb-6 text-center">
          <span className="grid size-14 place-items-center rounded-full bg-paper/[0.06] text-paper/50">
            <ChatsIcon />
          </span>
          <p className="max-w-xs text-sm leading-relaxed text-paper/55">{t("chats.emptyBody")}</p>
        </div>
      )}
      <div className="flex flex-col gap-6">
        {recent.length > 0 && (
          <section aria-label={t("chats.recent")}>
            <h2 className="eyebrow px-1 pb-3">{t("chats.recent")}</h2>
            <ul className="divide-y divide-hair overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
              {recent.map((chat) => (
                <ChatRow key={chat.id} chat={chat} favorites={favorites} showSite />
              ))}
            </ul>
          </section>
        )}
        {favorites.length > 0 && (
          <section aria-label={t("chats.favorites")}>
            <h2 className="eyebrow px-1 pb-3">{t("chats.favorites")}</h2>
            <div className="flex flex-col gap-2">
              {favorites.map((favorite) => (
                <SiteChats
                  key={favorite.id}
                  url={favorite.url}
                  name={favorite.name}
                  chats={chats}
                  favorites={favorites}
                />
              ))}
            </div>
          </section>
        )}
        {history.length > 0 && (
          <section aria-label={t("chats.history")}>
            <h2 className="eyebrow px-1 pb-3">{t("chats.history")}</h2>
            <div className="flex flex-col gap-2">
              {history.map((url) => (
                <SiteChats
                  key={url}
                  url={url}
                  name={displayHost(url)}
                  chats={chats}
                  favorites={favorites}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </Screen>
  );
}

interface SiteChatsProps {
  url: string;
  name: string;
  chats: readonly ChatSession[];
  favorites: readonly Favorite[];
}

/** A favorite or a history address as a dropdown: closed it shows how many chats the site has. */
function SiteChats({ url, name, chats, favorites }: SiteChatsProps) {
  const t = useT();
  const icon = useIconForUrl(url, favorites);
  const domain = siteOf(url);
  const saved = domain ? savedFor(chats, domain) : [];

  return (
    <details className="group overflow-hidden rounded-2xl border border-hair bg-paper/[0.04]">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 active:bg-paper/[0.06]">
        <SiteTile name={name} icon={icon} />
        <span className="min-w-0 flex-1 truncate text-base font-medium">{name}</span>
        <span className="shrink-0 rounded-full bg-paper/[0.08] px-2.5 py-0.5 text-xs font-medium text-paper/70 tabular-nums">
          {saved.length}
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 text-paper/45 transition-transform duration-200 group-open:rotate-180"
        >
          <DownIcon />
        </span>
      </summary>
      {saved.length === 0 ? (
        <p className="border-t border-hair px-4 py-3 text-sm text-paper/55">{t("chats.none")}</p>
      ) : (
        <ul className="divide-y divide-hair border-t border-hair">
          {saved.map((chat) => (
            <ChatRow key={chat.id} chat={chat} favorites={favorites} url={url} />
          ))}
        </ul>
      )}
    </details>
  );
}

interface ChatRowProps {
  chat: ChatSession;
  favorites: readonly Favorite[];
  /** The address the list knows for the chat's site; without it the site's home page opens. */
  url?: string;
  /** Names the site on the second line, for lists that mix sites. */
  showSite?: boolean;
}

function ChatRow({ chat, favorites, url, showSite = false }: ChatRowProps) {
  const openChat = useApp((s) => s.openChat);
  const locale = useApp(selectLocale);
  const icon = useIconForUrl(`https://${chat.domain}/`, favorites);
  const date = new Date(chat.updatedAt).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
  const detail = [showSite ? chat.domain : null, chat.recipeName, date].filter(Boolean).join(" · ");

  return (
    <li>
      <button
        type="button"
        onClick={() => openChat(chat, url)}
        className="flex w-full items-center gap-3 px-4 py-3 text-start active:bg-paper/[0.08]"
      >
        {showSite && <SiteTile name={chat.domain} icon={icon} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-paper">{chat.title}</span>
          <span className="block truncate text-xs text-paper/55">{detail}</span>
        </span>
      </button>
    </li>
  );
}
