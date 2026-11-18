/** What a shortcut can do. Every entry can be bound to any keys; `runActions.ts` carries each one out. */

export type ActionGroup = "navigate" | "tabs" | "windows" | "page" | "view" | "tools" | "app";

export const GROUP_TITLES: Readonly<Record<ActionGroup, string>> = {
  navigate: "Navigate",
  tabs: "Tabs",
  windows: "Windows",
  page: "Page",
  view: "Scroll and move",
  tools: "Tools",
  app: "App",
};

export const GROUP_ORDER: readonly ActionGroup[] = [
  "navigate",
  "tabs",
  "windows",
  "page",
  "view",
  "tools",
  "app",
];

export interface ActionInfo {
  id: string;
  group: ActionGroup;
  label: string;
  /** A count before the key (`5j`) repeats it, and holding the key repeats it. */
  repeatable?: boolean;
}

const action = (group: ActionGroup, id: string, label: string, repeatable = false): ActionInfo => ({
  id,
  group,
  label,
  repeatable,
});

const TAB_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

export const ACTIONS: readonly ActionInfo[] = [
  action("navigate", "nav.back", "Back", true),
  action("navigate", "nav.forward", "Forward", true),
  action("navigate", "nav.reload", "Reload page"),
  action("navigate", "nav.address", "Open address or ask the assistant"),
  action("navigate", "nav.newTab", "New tab"),
  action("navigate", "nav.history", "History"),
  action("navigate", "nav.favorites", "Favorites"),
  action("navigate", "nav.chats", "Assistant chats"),
  action("navigate", "nav.downloads", "Downloads"),
  action("navigate", "nav.recipes", "Recipes"),
  action("navigate", "nav.library", "Recipe library"),
  action("navigate", "nav.stats", "Usage"),
  action("navigate", "nav.settings", "Settings"),
  action("navigate", "nav.keybindings", "Keyboard shortcuts"),

  action("tabs", "tab.switcher", "Show all tabs"),
  action("tabs", "tab.next", "Next tab", true),
  action("tabs", "tab.prev", "Previous tab", true),
  action("tabs", "tab.close", "Close tab"),
  action("tabs", "tab.closeOthers", "Close other tabs"),
  ...TAB_NUMBERS.map((number) => action("tabs", `tab.select${number}`, `Go to tab ${number}`)),
  action("tabs", "tab.last", "Go to the last tab"),

  action("page", "page.find", "Find in page"),
  action("page", "page.findNext", "Next match", true),
  action("page", "page.findPrev", "Previous match", true),
  action("page", "page.zoomIn", "Zoom in", true),
  action("page", "page.zoomOut", "Zoom out", true),
  action("page", "page.zoomReset", "Actual size"),
  action("page", "page.copyUrl", "Copy page address"),
  action("page", "page.focus", "Type in the page"),
  action("page", "page.focusShell", "Use shortcuts on the page"),
  action("page", "page.focusToggle", "Switch between the page and shortcuts"),

  action("windows", "tile.addRight", "Add a window on the right"),
  action("windows", "tile.addLeft", "Add a window on the left"),
  action("windows", "tile.addBelow", "Add a window below"),
  action("windows", "tile.addAbove", "Add a window above"),
  action("windows", "tile.focusLeft", "Go to the window on the left"),
  action("windows", "tile.focusRight", "Go to the window on the right"),
  action("windows", "tile.focusUp", "Go to the window above"),
  action("windows", "tile.focusDown", "Go to the window below"),
  action("windows", "tile.focusNext", "Go to the next window", true),
  action("windows", "tile.focusPrev", "Go to the previous window", true),
  action("windows", "tile.moveLeft", "Move the window left"),
  action("windows", "tile.moveRight", "Move the window right"),
  action("windows", "tile.moveUp", "Move the window up"),
  action("windows", "tile.moveDown", "Move the window down"),
  action("windows", "tile.grow", "Make the window larger", true),
  action("windows", "tile.shrink", "Make the window smaller", true),
  action("windows", "tile.equalize", "Make the windows equal in size"),
  action("windows", "tile.flip", "Switch this window's split between side by side and stacked"),
  action("windows", "tile.arrangeRow", "Arrange all windows side by side"),
  action("windows", "tile.arrangeColumn", "Arrange all windows stacked"),
  action("windows", "tile.arrangeGrid", "Arrange all windows in a grid"),
  action("windows", "tile.close", "Close the window"),
  action("windows", "tile.only", "Keep only this window"),
  action("windows", "tile.saveFolder", "Save the windows as a folder"),

  action("view", "view.down", "Down: next item, or scroll the page", true),
  action("view", "view.up", "Up: previous item, or scroll the page", true),
  action("view", "view.left", "Scroll left", true),
  action("view", "view.right", "Scroll right", true),
  action("view", "view.halfDown", "Half a screen down", true),
  action("view", "view.halfUp", "Half a screen up", true),
  action("view", "view.pageDown", "A screen down", true),
  action("view", "view.pageUp", "A screen up", true),
  action("view", "view.top", "Top"),
  action("view", "view.bottom", "Bottom"),
  action("view", "view.activate", "Open the selected item"),
  action("view", "view.close", "Close what is open"),

  action("tools", "tool.colorPick", "Pick a color"),
  action("tools", "tool.techDetect", "Detect the page's technologies"),
  action("tools", "tool.videoControls", "Turn video controls on or off"),
  action("tools", "tool.adBlock", "Turn ad blocking on or off"),
  action("tools", "tool.blockPopups", "Turn pop-up blocking on or off"),
  action("tools", "tool.theme", "Switch between system, light and dark"),
  action("tools", "tool.incognito", "Turn incognito on or off"),

  action("app", "app.palette", "Command palette"),
  action("app", "app.fab", "Show or hide the floating button"),
];

export const ACTIONS_BY_ID: Readonly<Record<string, ActionInfo>> = Object.fromEntries(
  ACTIONS.map((info) => [info.id, info]),
);
