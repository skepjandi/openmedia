// Release title and notes from conventional-commit subjects, e.g. `feat(library): add shelves (#184)`.

const SECTIONS = [
  ["feat", "New"],
  ["fix", "Fixed"],
  ["perf", "Faster"],
  ["refactor", "Under the hood"],
  ["docs", "Documentation"],
];
const SUBJECT = /^(\w+)(?:\(([^)]+)\))?!?:\s+(.+?)(?:\s+\(#(\d+)\))?$/;

/** Parses one commit subject; null for merge noise, version bumps and dependency updates. */
export function parseSubject(subject) {
  const match = SUBJECT.exec(subject.trim());
  if (!match) return null;
  const [, type, scope, text, pr] = match;
  if (type === "chore" && (scope === "release" || scope === "deps" || scope === "deps-dev"))
    return null;
  return { type, scope: scope ?? "", text, pr: pr ?? "" };
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function line(change, repository) {
  const scope = change.scope ? `**${change.scope}**: ` : "";
  const pr = change.pr
    ? ` ([#${change.pr}](https://github.com/${repository}/pull/${change.pr}))`
    : "";
  return `- ${scope}${sentence(change.text)}${pr}`;
}

/** Newest first. The headline is the newest feature, else the newest fix. */
export function releaseTitle(version, subjects) {
  const changes = subjects.map(parseSubject).filter(Boolean);
  const headline = (changes.find((c) => c.type === "feat") ?? changes.find((c) => c.type === "fix"))
    ?.text;
  return headline ? `OpenMedia ${version}: ${sentence(headline)}` : `OpenMedia ${version}`;
}

export function releaseNotes({ version, previousTag, subjects, repository }) {
  const changes = subjects.map(parseSubject).filter(Boolean);
  const parts = [];
  for (const [type, heading] of SECTIONS) {
    const group = changes.filter((c) => c.type === type);
    if (group.length)
      parts.push(`## ${heading}\n\n${group.map((c) => line(c, repository)).join("\n")}`);
  }
  const listed = new Set(SECTIONS.map(([type]) => type));
  const rest = changes.filter((c) => !listed.has(c.type));
  if (rest.length) parts.push(`## Other\n\n${rest.map((c) => line(c, repository)).join("\n")}`);
  if (parts.length === 0) parts.push("Maintenance release: dependency and build updates only.");
  if (previousTag)
    parts.push(
      `**Full changelog**: https://github.com/${repository}/compare/${previousTag}...v${version}`,
    );
  return `${parts.join("\n\n")}\n`;
}
