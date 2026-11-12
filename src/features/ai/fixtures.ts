import type { PreparedRequest, Proposal } from "./ipc";

export const prepared: PreparedRequest = {
  id: "job-1",
  providerName: "Anthropic",
  model: "claude-x",
  domain: "youtube.com",
  recipeId: null,
  recipeName: null,
  payload: "SYSTEM\n\nUSER",
  tokenEstimate: 1234,
};

export const proposal: Proposal = {
  id: "job-1",
  kind: "newOption",
  summary: "Hide the suggested videos",
  recipeId: "youtube",
  recipeName: "YouTube",
  option: {
    id: null,
    label: "Hide suggested videos",
    description: "Removes the related list.",
    group: "content",
  },
  rules: [
    {
      label: "Related list",
      kind: "style",
      selector: "#related",
      matches: 3,
      code: null,
      powers: [],
    },
    { label: "End screen", kind: "style", selector: ".end", matches: 0, code: null, powers: [] },
  ],
  unmatched: 1,
  runsCode: false,
  publishable: true,
};
