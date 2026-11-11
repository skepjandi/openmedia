import { invoke } from "@tauri-apps/api/core";

export interface RulePreview {
  label: string;
  kind: "hide" | "css";
  selector: string;
  declarations: Record<string, string>;
}

export interface OptionPreview {
  label: string;
  description: string;
  onByDefault: boolean;
}

/** One page of a hub, as the catalog shows it before it is installed. */
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
  /** The version already installed under this id, which adding would replace. */
  replaces: string | null;
  /** The pages a hub recipe opens; absent or empty for an ordinary recipe. */
  tabs?: HubPreviewTab[];
}

/** Platform and origin tags are joined by the optional hub listing tag. */
export type MarketTag = "official" | "community" | "mobile" | "desktop" | "hub";

export interface MarketRating {
  /** The smoothed mean to one decimal, or null until enough people have rated. */
  average: number | null;
  count: number;
}

export interface MarketItem {
  id: string;
  name: string;
  version: string;
  author: string;
  summary: string;
  hosts: string[];
  featured: boolean;
  installs: number | null;
  installedVersion: string | null;
  updateAvailable: boolean;
  /** Platform tags plus exactly one origin tag. Unknown tags are ignored by the shell. */
  tags: string[];
  homepage: string | null;
  /** Null when the ratings could not be fetched. */
  rating: MarketRating | null;
  /** The stars this device gave, if any. */
  myRating: number | null;
}

export interface MarketComment {
  id: string;
  /** Ten hex characters, stable across recipes, so a commenter can be blocked. */
  commenter: string;
  text: string;
  createdAt: number;
  /** Written by this device's Pro identity, so it can be deleted here. */
  mine: boolean;
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

export interface MarketListing {
  items: MarketItem[];
  /** Names of installed recipes that were withdrawn; Rust already removed them. */
  withdrawn: string[];
}

export interface MarketStatus {
  /** False when the build has no marketplace address and keys. */
  available: boolean;
  countInstalls: boolean;
}

export type ReportReason = "harmful" | "broken" | "misleading" | "spam" | "other";

export interface SubmitResult {
  submissionId: string;
  firstSubmission: boolean;
}

async function command(name: string, args?: Record<string, unknown>): Promise<void> {
  await invoke(name, args);
}

export const marketplace = {
  status: () => invoke<MarketStatus>("marketplace_status"),
  setCounting: (enabled: boolean) => command("marketplace_set_counting", { enabled }),
  /** Fetches and verifies the signed catalog. Rejects with a short fixed message on any failure. */
  list: () => invoke<MarketListing>("marketplace_list"),
  preview: (recipeId: string) => invoke<RecipePreview>("marketplace_preview", { recipeId }),
  install: (recipeId: string) => command("marketplace_install", { recipeId }),
  uninstall: (recipeId: string) => command("marketplace_uninstall", { recipeId }),
  report: (recipeId: string, reason: ReportReason) =>
    command("marketplace_report", { recipeId, reason }),
  submit: (recipeId: string, slug: string, summary: string, author: string) =>
    invoke<SubmitResult>("marketplace_submit", { recipeId, slug, summary, author }),
  setRating: (recipeId: string, stars: number) =>
    command("marketplace_set_rating", { recipeId, stars }),
  comments: (recipeId: string) =>
    invoke<{ comments: MarketComment[] }>("marketplace_comments", { recipeId }).then(
      (result) => result.comments,
    ),
  postComment: (recipeId: string, text: string) =>
    command("marketplace_post_comment", { recipeId, text }),
  deleteComment: (commentId: string) => command("marketplace_delete_comment", { commentId }),
  reportComment: (commentId: string) => command("marketplace_report_comment", { commentId }),
  blockCommenter: (commenter: string) => command("marketplace_block_commenter", { commenter }),
  unblockCommenter: (commenter: string) => command("marketplace_unblock_commenter", { commenter }),
  blocked: () => invoke<string[]>("marketplace_blocked"),
};

export const onboarding = {
  /** The official recipes for this platform that the guide offers for quick access. */
  options: () => invoke<OnboardingOption[]>("onboarding_options"),
  /** Installs and favorites the chosen recipes; the caller then finishes the guide. */
  apply: (recipeIds: string[]) => invoke<OnboardingResult>("onboarding_apply", { recipeIds }),
};

export const sharing = {
  exportRecipes: (recipeIds: string[]) => invoke<string>("export_recipes", { recipeIds }),
  previewImport: (text: string) => invoke<RecipePreview[]>("preview_recipe_import", { text }),
  importRecipes: (text: string, recipeIds: string[]) =>
    command("import_recipes", { text, recipeIds }),
  removeImported: (recipeId: string) => command("remove_imported_recipe", { recipeId }),
};
