import { useState } from "react";
import { useApp } from "../../app/store";
import { useT } from "../../i18n/useT";
import { MAX_FAVORITE_NAME_CHARS } from "../../shared/favorites";
import type { Workspace } from "../../shared/ipc";
import { Group, Section, field, quietButton } from "../settings/ui";
import { tileUrls } from "./layout";

/** The saved window layouts: open, rename or delete them. Desktop only, like the layouts. */
export function WorkspacesSection() {
  const desktop = useApp((s) => s.desktop);
  const workspaces = useApp((s) => s.state?.workspaces);
  const t = useT();
  if (!desktop) return null;
  return (
    <Section title={t("tile.workspaces")} note={t("tile.workspacesHint")}>
      {workspaces && workspaces.length > 0 && (
        <Group>
          {workspaces.map((workspace) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} all={workspaces} />
          ))}
        </Group>
      )}
    </Section>
  );
}

function WorkspaceRow({ workspace, all }: { workspace: Workspace; all: readonly Workspace[] }) {
  const t = useT();
  const openWorkspace = useApp((s) => s.openWorkspace);
  const saveWorkspaces = useApp((s) => s.saveWorkspaces);
  const [name, setName] = useState(workspace.name);

  const keep = (changed: readonly Workspace[]) =>
    saveWorkspaces(changed.map(({ id, name: kept, layout }) => ({ id, name: kept, layout })));
  const rename = () => {
    const next = name.trim();
    if (!next || next === workspace.name) {
      setName(workspace.name);
      return;
    }
    void keep(all.map((entry) => (entry.id === workspace.id ? { ...entry, name: next } : entry)));
  };

  return (
    <div className="flex items-center gap-3 p-3">
      <input
        value={name}
        maxLength={MAX_FAVORITE_NAME_CHARS}
        aria-label={t("tile.workspaceName")}
        onChange={(event) => setName(event.target.value)}
        onBlur={rename}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={`${field} flex-1`}
      />
      <span className="shrink-0 text-sm text-paper/55">
        {t("tile.pageCount", { count: tileUrls(workspace.layout).length })}
      </span>
      <button type="button" onClick={() => openWorkspace(workspace)} className={quietButton}>
        {t("tile.open")}
      </button>
      <button
        type="button"
        aria-label={t("tile.workspaceDelete", { name: workspace.name })}
        onClick={() => void keep(all.filter((entry) => entry.id !== workspace.id))}
        className={quietButton}
      >
        {t("common.delete")}
      </button>
    </div>
  );
}
