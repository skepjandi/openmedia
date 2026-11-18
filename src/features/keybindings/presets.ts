import { normalizeSequence } from "./chord";

/** The key sets a person can start from. Standard is a browser's; Vim and Emacs add their own on top. */
export type Profile = "standard" | "vim" | "emacs";

export const PROFILES: readonly Profile[] = ["standard", "vim", "emacs"];

/** Action id to its bindings. A binding is chords separated by spaces; `Ctrl` is the Control key on a Mac. */
export type Bindings = Readonly<Record<string, readonly string[]>>;

const STANDARD: Bindings = {
  "nav.back": ["Mod+[", "Alt+ArrowLeft"],
  "nav.forward": ["Mod+]", "Alt+ArrowRight"],
  "nav.reload": ["Mod+r", "F5"],
  "nav.address": ["Mod+l"],
  "nav.newTab": ["Mod+t"],
  "nav.history": ["Mod+y"],
  "nav.favorites": ["Mod+Shift+b"],
  "nav.downloads": ["Mod+Shift+j"],
  "nav.recipes": ["Mod+Shift+r"],
  "nav.settings": ["Mod+,"],
  "nav.keybindings": ["Mod+/"],

  "tab.switcher": ["Mod+Shift+o"],
  "tab.next": ["Ctrl+Tab", "Mod+Alt+ArrowRight"],
  "tab.prev": ["Ctrl+Shift+Tab", "Mod+Alt+ArrowLeft"],
  "tab.close": ["Mod+Shift+w"],
  "tab.select1": ["Mod+1"],
  "tab.select2": ["Mod+2"],
  "tab.select3": ["Mod+3"],
  "tab.select4": ["Mod+4"],
  "tab.select5": ["Mod+5"],
  "tab.select6": ["Mod+6"],
  "tab.select7": ["Mod+7"],
  "tab.select8": ["Mod+8"],
  "tab.last": ["Mod+9"],

  "page.find": ["Mod+f"],
  "page.findNext": ["Mod+g"],
  "page.findPrev": ["Mod+Shift+g"],
  "page.zoomIn": ["Mod+=", "Mod+Shift+="],
  "page.zoomOut": ["Mod+-"],
  "page.zoomReset": ["Mod+0"],
  "page.copyUrl": ["Mod+Shift+c"],
  "page.focusToggle": ["Mod+;"],

  "view.close": ["Escape"],

  "app.palette": ["Mod+Shift+p"],
};

const withStandard = (id: string, ...extra: string[]): string[] => [
  ...(STANDARD[id] ?? []),
  ...extra,
];

const VIM: Bindings = {
  "view.down": ["j"],
  "view.up": ["k"],
  "view.left": ["h"],
  "view.right": ["l"],
  "view.halfDown": ["d", "Ctrl+d"],
  "view.halfUp": ["u", "Ctrl+u"],
  "view.pageDown": ["Ctrl+f"],
  "view.pageUp": ["Ctrl+b"],
  "view.top": ["g g"],
  "view.bottom": ["G"],

  "nav.back": withStandard("nav.back", "H"),
  "nav.forward": withStandard("nav.forward", "L"),
  "nav.reload": withStandard("nav.reload", "r"),
  "nav.address": withStandard("nav.address", "o"),
  "nav.newTab": withStandard("nav.newTab", "t"),
  "nav.history": withStandard("nav.history", "g h"),
  "nav.favorites": withStandard("nav.favorites", "g f"),
  "nav.downloads": withStandard("nav.downloads", "g d"),
  "nav.settings": withStandard("nav.settings", "g s"),
  "nav.keybindings": withStandard("nav.keybindings", "?"),

  "tab.switcher": withStandard("tab.switcher", "T"),
  "tab.next": withStandard("tab.next", "K", "g t"),
  "tab.prev": withStandard("tab.prev", "J", "g T"),
  "tab.close": withStandard("tab.close", "x"),

  "page.find": withStandard("page.find", "/"),
  "page.findNext": withStandard("page.findNext", "n"),
  "page.findPrev": withStandard("page.findPrev", "N"),
  "page.copyUrl": withStandard("page.copyUrl", "y y"),
  "page.focus": ["i"],

  "app.palette": withStandard("app.palette", ":"),
};

const EMACS: Bindings = {
  "view.down": ["Ctrl+n"],
  "view.up": ["Ctrl+p"],
  "view.pageDown": ["Ctrl+v"],
  "view.pageUp": ["Alt+v"],
  "view.top": ["Alt+Shift+,"],
  "view.bottom": ["Alt+Shift+."],
  "view.close": withStandard("view.close", "Ctrl+g"),

  "nav.address": withStandard("nav.address", "Ctrl+x Ctrl+f"),
  "nav.keybindings": withStandard("nav.keybindings", "Ctrl+h b"),

  "tab.switcher": withStandard("tab.switcher", "Ctrl+x b"),
  "tab.next": withStandard("tab.next", "Ctrl+x ArrowRight"),
  "tab.prev": withStandard("tab.prev", "Ctrl+x ArrowLeft"),
  "tab.close": withStandard("tab.close", "Ctrl+x k"),

  "page.find": withStandard("page.find", "Ctrl+s"),

  "app.palette": withStandard("app.palette", "Alt+x"),
};

const SOURCES: Readonly<Record<Profile, Bindings>> = {
  standard: STANDARD,
  vim: { ...STANDARD, ...VIM },
  emacs: { ...STANDARD, ...EMACS },
};

/** Vim's keys take a count: `5j` scrolls five lines. */
export const profileTakesCounts = (profile: Profile): boolean => profile === "vim";

/** A profile's bindings, read for this platform. A chord that cannot be read is left out. */
export function profileBindings(profile: Profile, mac: boolean): Map<string, string[]> {
  const bindings = new Map<string, string[]>();
  for (const [id, sequences] of Object.entries(SOURCES[profile])) {
    const read = sequences
      .map((sequence) => normalizeSequence(sequence, mac))
      .filter((sequence): sequence is string => sequence !== null);
    bindings.set(id, [...new Set(read)]);
  }
  return bindings;
}

/** The actions a profile adds its own keys to; where those keys clash with Standard's, the profile wins. */
export function profileOwnActions(profile: Profile): ReadonlySet<string> {
  if (profile === "vim") return new Set(Object.keys(VIM));
  if (profile === "emacs") return new Set(Object.keys(EMACS));
  return new Set();
}
