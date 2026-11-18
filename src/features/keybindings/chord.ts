/**
 * Key chords as text. A chord is modifiers and one key joined by `+` (`Mod+Shift+t`); a binding is
 * one or more chords separated by spaces (`g g`, `Ctrl+x Ctrl+f`).
 *
 * `Mod` is the platform's command key: Cmd on a Mac, Ctrl elsewhere, so one binding reads the
 * same on every desktop. `Ctrl` is the Control key on a Mac and means `Mod` anywhere else.
 * Printable keys without a modifier keep their case (`G` is Shift and g), so a bare key never
 * carries a `Shift+`.
 */

/** Just the parts of a keyboard event the chord needs; a real `KeyboardEvent` fits. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

/** Keys that only change another key's meaning; pressing one alone is not a chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "CapsLock",
  "Dead",
  "Process",
  "Unidentified",
]);

export const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Escape",
  "Enter",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const KEY_ALIASES: Readonly<Record<string, string>> = {
  " ": "Space",
  Esc: "Escape",
  Return: "Enter",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Del: "Delete",
  Ins: "Insert",
  PgUp: "PageUp",
  PgDn: "PageDown",
};

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  cmd: "meta",
  command: "meta",
  control: "ctrl",
  option: "alt",
  opt: "alt",
  win: "meta",
  super: "meta",
};

/** The character a physical punctuation key types without Shift, for chords that carry a modifier. */
const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/;

const isNamed = (key: string): boolean => NAMED_KEYS.has(key) || FUNCTION_KEY.test(key);

/**
 * Chords the system menu or the text fields own: Cut, Copy, Paste, Select All, Undo, Quit, Hide,
 * Minimize and Close Window. They cannot be bound.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "Mod+c",
  "Mod+v",
  "Mod+x",
  "Mod+a",
  "Mod+z",
  "Mod+Shift+z",
  "Mod+q",
  "Mod+h",
  "Mod+m",
  "Mod+w",
]);

export const isReservedChord = (chord: string): boolean => RESERVED.has(chord);

interface Parts {
  mods: Set<Modifier>;
  key: string;
}

const compose = ({ mods, key }: Parts): string =>
  [...MODIFIER_ORDER.filter((modifier) => mods.has(modifier)), key].join("+");

/** The key of a chord that carries a modifier: the physical key, since Alt rewrites what it types. */
function modifiedKey(event: KeyLike): string {
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit) return digit[1];
  return PUNCTUATION_BY_CODE[event.code] ?? event.key.toLowerCase();
}

/** The chord a key press makes, or null for a press that is only a modifier. */
export function chordFromEvent(event: KeyLike, mac: boolean): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const named = KEY_ALIASES[event.key] ?? event.key;
  const mods = new Set<Modifier>();
  if (mac ? event.metaKey : event.ctrlKey) mods.add("Mod");
  if (mac && event.ctrlKey) mods.add("Ctrl");
  if (event.altKey) mods.add("Alt");
  if (!mac && event.metaKey) mods.add("Super");
  if (isNamed(named)) {
    if (event.shiftKey) mods.add("Shift");
    return compose({ mods, key: named });
  }
  if (named.length !== 1 && !/^[\p{L}\p{N}]$/u.test(named)) return null;
  if (mods.size === 0) return named;
  if (event.shiftKey) mods.add("Shift");
  return compose({ mods, key: modifiedKey(event) });
}

/** Splits `Mod+Shift+t` into its modifier words and key; the key may itself be `+`. */
function splitText(text: string): { tokens: string[]; key: string } {
  if (text === "+") return { tokens: [], key: "+" };
  if (text.endsWith("++")) return { tokens: text.slice(0, -2).split("+"), key: "+" };
  const tokens = text.split("+");
  return { tokens, key: tokens.pop() ?? "" };
}

/** Reads one chord from text. Null when it names no key or an unknown modifier. */
export function normalizeChord(text: string, mac: boolean): string | null {
  const { tokens, key } = splitText(text);
  if (!key) return null;
  const mods = new Set<Modifier>();
  for (const token of tokens) {
    const lower = token.toLowerCase();
    const word = MODIFIER_ALIASES[lower] ?? lower;
    if (word === "mod") mods.add("Mod");
    else if (word === "ctrl") mods.add(mac ? "Ctrl" : "Mod");
    else if (word === "meta") mods.add(mac ? "Mod" : "Super");
    else if (word === "alt") mods.add("Alt");
    else if (word === "shift") mods.add("Shift");
    else return null;
  }
  const named = KEY_ALIASES[key] ?? key;
  if (isNamed(named)) return compose({ mods, key: named });
  if ([...named].length !== 1) return null;
  const hasModifier = [...mods].some((modifier) => modifier !== "Shift");
  const normalized = hasModifier || mods.has("Shift") ? named.toLowerCase() : named;
  return compose({ mods, key: normalized });
}

/** Reads a binding: chords separated by spaces. Null when any chord is invalid or there are none. */
export function normalizeSequence(text: string, mac: boolean): string | null {
  const chords = text.trim().split(/\s+/);
  const normalized: string[] = [];
  for (const chord of chords) {
    const next = normalizeChord(chord, mac);
    if (!next) return null;
    normalized.push(next);
  }
  return normalized.length === 0 ? null : normalized.join(" ");
}

export const splitSequence = (sequence: string): string[] => sequence.split(" ");

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
};
const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
};

function splitChord(chord: string): Parts {
  const { tokens, key } = splitText(chord);
  return { mods: new Set(tokens.filter(Boolean) as Modifier[]), key };
}

/** One chord as the person reads it: ⌘⇧T on a Mac, Ctrl+Shift+T elsewhere. */
export function formatChord(chord: string, mac: boolean): string {
  const { mods, key } = splitChord(chord);
  const hasModifier = mods.size > 0;
  const label = KEY_LABELS[key] ?? (hasModifier ? key.toUpperCase() : key);
  const ordered = MODIFIER_ORDER.filter((modifier) => mods.has(modifier));
  if (mac)
    return `${ordered.map((modifier) => MAC_SYMBOLS[modifier] ?? modifier).join("")}${label}`;
  const names = ordered.map((modifier) =>
    modifier === "Mod" ? "Ctrl" : modifier === "Super" ? "Win" : modifier,
  );
  return [...names, label].join("+");
}

export const formatSequence = (sequence: string, mac: boolean): string =>
  splitSequence(sequence)
    .map((chord) => formatChord(chord, mac))
    .join(" ");

const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * The native menu accelerator for a binding, or null when the menu must not own it. A menu
 * accelerator takes the key before the page sees it, so it is only for a single chord that has
 * the command key (or is a function key): `Ctrl+n` or a bare `j` would break typing in the page.
 */
export function toAccelerator(sequence: string): string | null {
  if (sequence.includes(" ")) return null;
  const { mods, key } = splitChord(sequence);
  if (isReservedChord(sequence)) return null;
  if (!mods.has("Mod") && !FUNCTION_KEY.test(key)) return null;
  const parts = MODIFIER_ORDER.filter((modifier) => mods.has(modifier)).map((modifier) =>
    modifier === "Mod" ? "CmdOrCtrl" : modifier,
  );
  const native = ACCELERATOR_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...parts, native].join("+");
}

/** Whether a chord may fire while the person is typing in a field. */
export function worksWhileTyping(chord: string): boolean {
  const { mods, key } = splitChord(chord);
  if (isReservedChord(chord)) return false;
  return mods.has("Mod") || FUNCTION_KEY.test(key) || chord === "Escape";
}
