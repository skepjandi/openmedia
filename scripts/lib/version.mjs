// The app version and store build numbers live in package.json and src-tauri/tauri.conf.json.
// This is the only code that edits them, so they cannot drift apart.
import fs from "node:fs";
import path from "node:path";

const BUILD_FIELDS = [
  [/("iOS":\s*\{[^}]*?"bundleVersion":\s*")(\d+)(")/, "iOS bundleVersion"],
  [/("macOS":\s*\{[^}]*?"bundleVersion":\s*")(\d+)(")/, "macOS bundleVersion"],
  [/("versionCode":\s*)(\d+)()/, "Android versionCode"],
];
const VERSION_PATTERN = /("version":\s*")(\d+\.\d+\.\d+)(")/;

export function versionFiles(root) {
  return {
    pkg: path.join(root, "package.json"),
    conf: path.join(root, "src-tauri/tauri.conf.json"),
    changelog: path.join(root, "CHANGELOG.md"),
  };
}

/** The version in package.json and tauri.conf.json (they must match; doctor reports a mismatch). */
export function readVersions(root) {
  const { pkg, conf } = versionFiles(root);
  const read = (file) => fs.readFileSync(file, "utf8").match(VERSION_PATTERN)?.[2] ?? null;
  return { pkg: read(pkg), conf: read(conf) };
}

/** [iOS bundleVersion, macOS bundleVersion, Android versionCode] from tauri.conf.json. */
export function readBuilds(root) {
  const text = fs.readFileSync(versionFiles(root).conf, "utf8");
  return BUILD_FIELDS.map(([pattern, label]) => {
    const match = text.match(pattern);
    if (!match) throw new Error(`could not find ${label} in tauri.conf.json`);
    return Number(match[2]);
  });
}

export function writeBuild(root, build) {
  const { conf } = versionFiles(root);
  let text = fs.readFileSync(conf, "utf8");
  for (const [pattern] of BUILD_FIELDS) text = text.replace(pattern, `$1${build}$3`);
  fs.writeFileSync(conf, text);
}

/** `patch`, `minor`, `major` or an explicit `x.y.z`, applied to `current`. */
export function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map(Number);
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "major") return `${major + 1}.0.0`;
  throw new Error(`version must be patch, minor, major or x.y.z (got "${spec}")`);
}

export function writeVersion(root, version) {
  const { pkg, conf } = versionFiles(root);
  for (const file of [pkg, conf]) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(VERSION_PATTERN, `$1${version}$3`));
  }
}

/** Adds a `chore(release)` entry under today's heading in CHANGELOG.md (creating the heading). */
export function addChangelogEntry(root, version, build, date = new Date()) {
  const { changelog } = versionFiles(root);
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((n, i) => (i === 0 ? n : String(n).padStart(2, "0")))
    .join("-");
  const entry = `### chore(release): version ${version}\n\n**Area:** \`chore(release)\`\n\n**Change:** The app version is \`${version}\` (build ${build}) in \`package.json\` and \`src-tauri/tauri.conf.json\`.\n\n`;
  let text = fs.readFileSync(changelog, "utf8");
  const heading = `## ${day}\n\n`;
  if (text.includes(heading)) {
    text = text.replace(heading, `${heading}${entry}`);
  } else {
    text = text.replace(/^## /m, `${heading}${entry}## `);
  }
  fs.writeFileSync(changelog, text);
}
