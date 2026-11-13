import { invoke } from "@tauri-apps/api/core";

export interface RulePreview {
  label: string;
  kind: "hide" | "css" | "script";
  selector: string;
  declarations: Record<string, string>;
  /** The script text of a `script` rule, shown in full; absent for other rules. */
  code?: string | null;
}

export interface OptionPreview {
  label: string;
  description: string;
  /** The labels of a choice option's states, in order; empty for an on/off switch. */
  choices: string[];
  onByDefault: boolean;
}

/** One page of a hub, as the library shows it before it is added. */
export interface HubPreviewTab {
  label: string;
  url: string;
  /** The page's own host, so the user sees which site each page belongs to. */
  host: string;
}

/** What a recipe would add, as Rust validated it: the review screen shows exactly this. */
export interface RecipePreview {
  id: string;
  name: string;
  version: string;
  author: string | null;
  notes: string | null;
  sites: string[];
  options: OptionPreview[];
  rules: RulePreview[];
  /** Whether any rule runs code on the pages. */
  runsCode: boolean;
  /** The version already installed under this id, which adding would replace. */
  replaces: string | null;
  /** The pages a hub recipe opens; absent or empty for an ordinary recipe. */
  tabs?: HubPreviewTab[];
}

/** The subject categories a bundled recipe can carry (`recipes/categories.json`). */
export type CategoryTag =
  | "ai"
  | "archive"
  | "education"
  | "games"
  | "music"
  | "news"
  | "podcasts"
  | "productivity"
  | "radio"
  | "reference"
  | "search"
  | "shopping"
  | "social"
  | "tech"
  | "travel"
  | "video";

/** Platform and origin tags are joined by subject categories and the optional hub listing tag. */
export type LibraryTag = "official" | "community" | "mobile" | "desktop" | "hub" | CategoryTag;

/** One bundled recipe, as the library lists it. */
export interface LibraryItem {
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  hosts: string[];
  /** Platform tags, subject categories, one origin tag, and `hub` for hub recipes. Unknown tags are ignored by the shell. */
  tags: string[];
  homepage: string | null;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** An official recipe offered during onboarding. */
export interface OnboardingOption {
  recipeId: string;
  name: string;
  summary: string;
  homepage: string;
  tags: string[];
}

export interface OnboardingResult {
  installed: string[];
  failed: string[];
}

export interface LibraryListing {
  items: LibraryItem[];
}

export type ShareState = "waiting" | "working" | "done" | "failed";

export type ShareErrorCode =
  "tooNew" | "limit" | "invalid" | "offline" | "busy" | "failed" | "cancelled";

/** Where a share stands. `errorCode` is set only when failed; `error` is Rust's own sentence. */
export interface ShareStatus {
  state: ShareState;
  prUrl: string | null;
  login: string | null;
  error: string | null;
  errorCode: ShareErrorCode | null;
}

async function command(name: string, args?: Record<string, unknown>): Promise<void> {
  await invoke(name, args);
}

/** The recipes compiled into the app. Everything here is local; nothing is fetched. */
export const recipeLibrary = {
  list: () => invoke<LibraryListing>("library_list"),
  preview: (recipeId: string) => invoke<RecipePreview>("library_preview", { recipeId }),
  install: (recipeId: string) => command("library_install", { recipeId }),
  uninstall: (recipeId: string) => command("library_uninstall", { recipeId }),
};

export const onboarding = {
  /** The official recipes for this platform that the guide offers for quick access. */
  options: () => invoke<OnboardingOption[]>("onboarding_options"),
  /** Installs and favorites the chosen recipes; the caller then finishes the guide. */
  apply: (recipeIds: string[]) => invoke<OnboardingResult>("onboarding_apply", { recipeIds }),
};

/** Sharing one of the user's recipes with the OpenMedia team. */
export const share = {
  /** True when this build knows the Worker's address. */
  available: () => invoke<boolean>("share_status_available"),
  /** Rejects with a plain sentence when the device-side policy check refuses the recipe. */
  start: (recipeId: string, summary: string) =>
    invoke<{ id: string }>("share_start", { recipeId, summary }),
  cancel: (id: string) => command("share_cancel", { id }),
  status: (id: string) => invoke<ShareStatus>("share_status", { id }),
  open: (id: string) => command("share_open", { id }),
  /** The GitHub login this device shares as after a first sign-in, or null. Never a token. */
  account: () => invoke<string | null>("share_account"),
  /** Forgets the GitHub account here and at the Worker; the next share signs in again. */
  signOut: () => command("share_sign_out"),
};
