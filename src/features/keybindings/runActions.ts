import { selectPage, useApp, type Sheet } from "../../app/store";
import { keyboard, siteView, type PageScroll } from "../../shared/ipc";
import type { Theme } from "../../shared/ipc";
import { runBackHandler } from "../back/backStack";
import { useFind } from "../find/findStore";
import { hiddenTabIds } from "../tabs/tabs";
import { activateFocused, focusEdge, moveFocus, scrollSheet } from "./dom";
import { setVideoPanel } from "../settings/videoPanel";
import { VIDEO_CONTROLS_DEFAULT } from "../../shared/videoControls";
import { usePalette } from "./paletteStore";
import { useKeybindings } from "./store";
import { RESIZE_STEP } from "../tiling/layout";
import { useFolderDialog } from "../tiling/folderDialog";

type Runner = (count: number) => void | Promise<void>;

const app = () => useApp.getState();

const showSheet =
  (sheet: Sheet): Runner =>
  () =>
    app().openSheet(sheet);

/** A page (Settings, History and the like) is on top of the site, so keys move within it. */
const sheetOpen = () => app().sheet !== "none";

async function repeat(count: number, step: () => void | Promise<void>): Promise<void> {
  for (let done = 0; done < count; done += 1) await step();
}

function scrollPage(scroll: PageScroll): Runner {
  return async (count) => {
    if (sheetOpen() || selectPage(app()) === null) {
      scrollSheet(scroll);
      return;
    }
    await repeat(count, () => keyboard.scroll(scroll));
  };
}

function scrollOrMove(scroll: "down" | "up"): Runner {
  return async (count) => {
    if (!sheetOpen()) {
      await scrollPage(scroll)(count);
      return;
    }
    await repeat(count, () => moveFocus(scroll === "down" ? 1 : -1));
  };
}

function edge(scroll: "top" | "bottom"): Runner {
  return async (count) => {
    if (sheetOpen()) {
      focusEdge(scroll === "top" ? "first" : "last");
      scrollSheet(scroll);
      return;
    }
    await scrollPage(scroll)(count);
  };
}

function switchTab(step: 1 | -1): Runner {
  return (count) => {
    const { sessions, activeId, openSession } = app();
    if (sessions.length < 2) return;
    const current = Math.max(
      sessions.findIndex((session) => session.id === activeId),
      0,
    );
    const next = (current + step * count) % sessions.length;
    openSession(sessions[(next + sessions.length) % sessions.length].id);
  };
}

function selectTab(position: number): Runner {
  return () => {
    const { sessions, openSession } = app();
    const session = position === -1 ? sessions[sessions.length - 1] : sessions[position];
    if (session) openSession(session.id);
  };
}

const THEME_CYCLE: readonly Theme[] = ["system", "light", "dark"];

function focusPage(): void {
  if (sheetOpen() || selectPage(app()) === null) return;
  void keyboard.focus("page");
}

const toggleFocus: Runner = () => {
  if (document.hasFocus()) focusPage();
  else void keyboard.focus("shell");
};

const copyAddress: Runner = async () => {
  const url = selectPage(app())?.url;
  if (url) await navigator.clipboard.writeText(url);
};

const RUNNERS: Readonly<Record<string, Runner>> = {
  "nav.back": (count) => repeat(count, () => app().goBack()),
  "nav.forward": (count) => repeat(count, () => siteView.goForward()),
  "nav.reload": () => siteView.reload(),
  "nav.address": showSheet("assistant"),
  "nav.newTab": () => app().openNewTab(),
  "nav.history": showSheet("history"),
  "nav.favorites": showSheet("favorites"),
  "nav.chats": showSheet("chats"),
  "nav.downloads": showSheet("downloads"),
  "nav.recipes": showSheet("recipes"),
  "nav.library": showSheet("library"),
  "nav.stats": showSheet("stats"),
  "nav.settings": showSheet("settings"),
  "nav.keybindings": showSheet("keybindings"),

  "tab.switcher": showSheet("tabs"),
  "tab.next": switchTab(1),
  "tab.prev": switchTab(-1),
  "tab.close": () => {
    const { sessions, activeId, closeSession } = app();
    if (sessions.length > 1 && activeId) closeSession(activeId);
  },
  "tab.closeOthers": () => {
    const { sessions, activeId, closeSession } = app();
    for (const id of hiddenTabIds(sessions, activeId)) closeSession(id);
  },
  "tab.select1": selectTab(0),
  "tab.select2": selectTab(1),
  "tab.select3": selectTab(2),
  "tab.select4": selectTab(3),
  "tab.select5": selectTab(4),
  "tab.select6": selectTab(5),
  "tab.select7": selectTab(6),
  "tab.select8": selectTab(7),
  "tab.last": selectTab(-1),

  "page.find": () => useFind.getState().openBar(),
  "page.findNext": (count) => repeat(count, () => useFind.getState().step(true)),
  "page.findPrev": (count) => repeat(count, () => useFind.getState().step(false)),
  "page.zoomIn": (count) => repeat(count, () => keyboard.zoom("in")),
  "page.zoomOut": (count) => repeat(count, () => keyboard.zoom("out")),
  "page.zoomReset": () => keyboard.zoom("reset"),
  "page.copyUrl": copyAddress,
  "page.focus": focusPage,
  "page.focusShell": () => keyboard.focus("shell"),
  "page.focusToggle": toggleFocus,

  "view.down": scrollOrMove("down"),
  "view.up": scrollOrMove("up"),
  "view.left": scrollPage("left"),
  "view.right": scrollPage("right"),
  "view.halfDown": scrollPage("halfDown"),
  "view.halfUp": scrollPage("halfUp"),
  "view.pageDown": scrollPage("pageDown"),
  "view.pageUp": scrollPage("pageUp"),
  "view.top": edge("top"),
  "view.bottom": edge("bottom"),
  "view.activate": activateFocused,
  "view.close": () => {
    runBackHandler();
  },

  "tile.addRight": () => usePalette.getState().pickPage("right"),
  "tile.addLeft": () => usePalette.getState().pickPage("left"),
  "tile.addBelow": () => usePalette.getState().pickPage("bottom"),
  "tile.addAbove": () => usePalette.getState().pickPage("top"),
  "tile.focusLeft": () => app().focusWindow("left"),
  "tile.focusRight": () => app().focusWindow("right"),
  "tile.focusUp": () => app().focusWindow("up"),
  "tile.focusDown": () => app().focusWindow("down"),
  "tile.focusNext": (count) => repeat(count, () => app().focusNextWindow(1)),
  "tile.focusPrev": (count) => repeat(count, () => app().focusNextWindow(-1)),
  "tile.moveLeft": () => app().swapWindow("left"),
  "tile.moveRight": () => app().swapWindow("right"),
  "tile.moveUp": () => app().swapWindow("up"),
  "tile.moveDown": () => app().swapWindow("down"),
  "tile.grow": (count) => repeat(count, () => app().resizeWindow(RESIZE_STEP)),
  "tile.shrink": (count) => repeat(count, () => app().resizeWindow(-RESIZE_STEP)),
  "tile.equalize": () => app().equalizeWindows(),
  "tile.flip": () => app().flipWindow(),
  "tile.arrangeRow": () => app().arrangeWindows("row"),
  "tile.arrangeColumn": () => app().arrangeWindows("column"),
  "tile.arrangeGrid": () => app().arrangeWindows("grid"),
  "tile.close": () => app().closeWindow(),
  "tile.only": () => app().keepOnlyWindow(),
  "tile.saveFolder": () => useFolderDialog.getState().setOpen(true),

  "tool.colorPick": () => (app().state?.colorPicker ? app().startColorPick() : undefined),
  "tool.techDetect": () => (app().state?.techDetector ? app().startTechDetect() : undefined),
  "tool.videoControls": () =>
    setVideoPanel(!(app().state?.videoControls ?? VIDEO_CONTROLS_DEFAULT).panel),
  "tool.adBlock": () => app().setAdBlock(!app().state?.adBlock),
  "tool.blockPopups": () => app().setBlockPopups(!app().state?.blockPopups),
  "tool.theme": () => {
    const current = THEME_CYCLE.indexOf(app().state?.theme ?? "system");
    return app().setTheme(THEME_CYCLE[(current + 1) % THEME_CYCLE.length]);
  },
  "tool.incognito": () => (app().incognito.active ? app().exitIncognito() : app().enterIncognito()),

  "app.palette": () => usePalette.getState().setOpen(true),
  "app.fab": () => useKeybindings.getState().setShowFab(!useKeybindings.getState().showFab),
};

/** How long the menu and the shell may both report one key press. */
const SAME_PRESS_MS = 120;
let last = { id: "", at: 0, source: "key" };

/**
 * Runs an action. The native menu and the shell can both see one key press, so the same action
 * from the other of the two within an instant runs once.
 */
export async function runAction(id: string, count = 1, source: "key" | "menu" = "key") {
  const runner = RUNNERS[id];
  if (!runner) return;
  const now = performance.now();
  if (last.id === id && last.source !== source && now - last.at < SAME_PRESS_MS) return;
  last = { id, at: now, source };
  try {
    await runner(count);
  } catch (error) {
    app().reportError(String(error));
  }
}
