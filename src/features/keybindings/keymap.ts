import { normalizeSequence, splitSequence, worksWhileTyping } from "./chord";
import { profileBindings, profileOwnActions, profileTakesCounts, type Profile } from "./presets";

/** The bindings a person chose, by action id. An entry replaces every default that action had. */
export type Overrides = Readonly<Record<string, readonly string[]>>;

/** Action id to the bindings in force, after the profile, the person's changes and conflicts. */
export function effectiveBindings(
  profile: Profile,
  overrides: Overrides,
  mac: boolean,
): Map<string, string[]> {
  const bindings = profileBindings(profile, mac);
  const chosen = new Set<string>();
  for (const [id, sequences] of Object.entries(overrides)) {
    const read = sequences
      .map((sequence) => normalizeSequence(sequence, mac))
      .filter((sequence): sequence is string => sequence !== null);
    bindings.set(id, [...new Set(read)]);
    chosen.add(id);
  }
  dropLosers(bindings, chosen, profileOwnActions(profile));
  return bindings;
}

/** When two actions claim the same keys, the person's choice beats the profile's, which beats Standard's. */
function dropLosers(
  bindings: Map<string, string[]>,
  chosen: ReadonlySet<string>,
  own: ReadonlySet<string>,
): void {
  const rank = (id: string) => (chosen.has(id) ? 2 : own.has(id) ? 1 : 0);
  const owners = new Map<string, string>();
  for (const [id, sequences] of bindings) {
    for (const sequence of sequences) {
      const holder = owners.get(sequence);
      if (holder === undefined || rank(id) >= rank(holder)) owners.set(sequence, id);
    }
  }
  for (const [id, sequences] of bindings) {
    bindings.set(
      id,
      sequences.filter((sequence) => owners.get(sequence) === id),
    );
  }
}

/** Sequences that are the start of a longer one, or the same keys as another action: worth a warning. */
export function conflictsOf(
  bindings: ReadonlyMap<string, readonly string[]>,
  id: string,
  sequence: string,
): string[] {
  const found: string[] = [];
  for (const [other, sequences] of bindings) {
    if (other === id) continue;
    const clash = sequences.some(
      (candidate) =>
        candidate === sequence ||
        candidate.startsWith(`${sequence} `) ||
        sequence.startsWith(`${candidate} `),
    );
    if (clash) found.push(other);
  }
  return found;
}

interface Node {
  action: string | null;
  children: Map<string, Node>;
}

const node = (): Node => ({ action: null, children: new Map() });

function insert(root: Node, sequence: string, action: string): void {
  let at = root;
  for (const chord of splitSequence(sequence)) {
    let next = at.children.get(chord);
    if (!next) {
      next = node();
      at.children.set(chord, next);
    }
    at = next;
  }
  at.action ??= action;
}

export type Press =
  { kind: "none" } | { kind: "pending" } | { kind: "run"; action: string; count: number };

const NONE: Press = { kind: "none" };
const PENDING: Press = { kind: "pending" };
const MAX_COUNT = 99;

/**
 * Follows key presses through the bindings. A binding of several chords waits for the rest, a
 * miss in the middle starts over with that chord, and in Vim a number first repeats the action.
 * While the person types in a field only the chords that are safe there take part.
 */
export class Matcher {
  private readonly everywhere = node();
  private readonly whileTyping = node();
  private readonly takesCounts: boolean;
  private at: Node | null = null;
  private typing = false;
  private digits = "";

  constructor(bindings: ReadonlyMap<string, readonly string[]>, profile: Profile) {
    this.takesCounts = profileTakesCounts(profile);
    for (const [action, sequences] of bindings) {
      for (const sequence of sequences) {
        insert(this.everywhere, sequence, action);
        if (worksWhileTyping(splitSequence(sequence)[0]))
          insert(this.whileTyping, sequence, action);
      }
    }
  }

  /** Whether the keys so far wait for more. */
  get waiting(): boolean {
    return this.at !== null || this.digits !== "";
  }

  reset(): void {
    this.at = null;
    this.digits = "";
  }

  press(chord: string, typing: boolean): Press {
    if (typing !== this.typing) this.reset();
    this.typing = typing;
    const root = typing ? this.whileTyping : this.everywhere;
    const start = this.at ?? root;
    if (this.at === null && this.countsDigit(chord, root)) {
      this.digits += chord;
      return PENDING;
    }
    const next = start.children.get(chord);
    if (!next) {
      if (this.at === null) {
        this.reset();
        return NONE;
      }
      this.reset();
      return this.press(chord, typing);
    }
    if (next.children.size > 0) {
      this.at = next;
      return PENDING;
    }
    return this.finish(next);
  }

  /** The wait for more keys ran out: what was typed so far runs if it is a binding on its own. */
  expire(): Press {
    const waiting = this.at;
    return waiting?.action ? this.finish(waiting) : this.discard();
  }

  private countsDigit(chord: string, root: Node): boolean {
    return (
      this.takesCounts &&
      !this.typing &&
      /^[0-9]$/.test(chord) &&
      (chord !== "0" || this.digits !== "") &&
      !root.children.has(chord)
    );
  }

  private finish(at: Node): Press {
    const count = this.digits === "" ? 1 : Math.min(Number(this.digits), MAX_COUNT);
    this.reset();
    return at.action ? { kind: "run", action: at.action, count } : NONE;
  }

  private discard(): Press {
    this.reset();
    return NONE;
  }
}
