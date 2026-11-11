#!/usr/bin/env node
/**
 * Publishes the official recipes (`recipes/official/*.json`) to the marketplace.
 *
 * The app ships no recipes. The official ones live in the marketplace like any other, under ids
 * `market.official.<site>`, and only the operator can publish under that prefix. This script does
 * not talk to Cloudflare: it writes a SQL file and prints the `wrangler d1 execute` command that
 * applies it. For every recipe the file inserts
 *   - a `submissions` row: channel 'official', status 'held', release_at 0, validated 1, the
 *     recipe as `recipe_json` (the next cron run publishes it, signing a new catalog), and
 *   - an `owners` row with token_hash 'official'. That value is never a real SHA-256, so nobody
 *     can ever present an edit token for the id.
 *
 * Usage:
 *   node scripts/official-recipes.mjs [--out FILE] [--only youtube,reddit] [--db NAME] [--local]
 *
 * Before running the printed command:
 *   - The Worker validates every recipe again when it publishes it, in "official mode" (it skips
 *     only the selector word screening and the page-wide-hide heuristics; everything structural
 *     still applies). Expect the publisher to refuse, and log the row as rejected, any recipe
 *     that still fails: bad tags, a duplicate or lower version than the published one, notes over
 *     the Worker's cap, a homepage its own match patterns do not cover. Check the result in D1:
 *       SELECT recipe_id, version, status FROM submissions WHERE channel = 'official';
 *   - To release a NEW version of a published recipe, raise `version` in its file and run this
 *     again: the Worker only publishes a version greater than the live one. Re-running with an
 *     unchanged version is harmless (the insert is skipped).
 *   - Takedown of an official recipe is the same as for any recipe: insert into `revocations`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECIPES = path.join(ROOT, "recipes", "official");
const OFFICIAL_PREFIX = "market.official.";
const OFFICIAL_TOKEN_HASH = "official";
const PLATFORM_TAGS = ["mobile", "desktop"];
const ALLOWED_ORIGINS = ["user", "ai", "imported"];
const MAX_SUMMARY = 140;
const DEFAULT_DB = "openmedia-marketplace";

function fail(message) {
  console.error(`official-recipes: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: "official-recipes.sql", only: undefined, db: DEFAULT_DB, local: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--local") options.local = true;
    else if (flag === "--out" || flag === "--only" || flag === "--db") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
      index += 1;
      if (flag === "--out") options.out = value;
      else if (flag === "--db") options.db = value;
      else options.only = value.split(",").map((site) => site.trim());
    } else fail(`unknown argument ${flag}`);
  }
  return options;
}

/** Checks what the operator can check without the Worker: shape, naming, tags, origin. */
function checked(site, recipe) {
  const problems = [];
  if (recipe.id !== `${OFFICIAL_PREFIX}${site}`)
    problems.push(`id must be ${OFFICIAL_PREFIX}${site}`);
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(recipe.version ?? ""))
    problems.push("version must be 1.2.3");
  if (!ALLOWED_ORIGINS.includes(recipe.origin))
    problems.push(
      `origin must be one of ${ALLOWED_ORIGINS.join(", ")} (the Worker refuses "bundled")`,
    );
  const tags = recipe.tags;
  if (
    !Array.isArray(tags) ||
    tags.length < 1 ||
    tags.length > PLATFORM_TAGS.length ||
    new Set(tags).size !== tags.length ||
    tags.some((tag) => !PLATFORM_TAGS.includes(tag))
  )
    problems.push("tags must be mobile and/or desktop, once each");
  if (typeof recipe.meta?.homepage !== "string" || !recipe.meta.homepage.startsWith("https://"))
    problems.push("meta.homepage must be an https address (onboarding needs it)");
  if (problems.length > 0) fail(`${site}: ${problems.join("; ")}`);
}

/** One line for the Marketplace row, made from the recipe's hub tabs or option labels. */
function summaryOf(recipe) {
  if (recipe.hub?.tabs.length) {
    let text = "Opens ";
    for (const { label } of recipe.hub.tabs) {
      const next = text === "Opens " ? `${text}${label}` : `${text}, ${label}`;
      if (next.length > MAX_SUMMARY) break;
      text = next;
    }
    return text;
  }

  const labels = (recipe.options ?? []).map((option) =>
    option.label.replace(/^Hide (the |all )?/i, "").replace(/\.$/, ""),
  );
  const prefix = "Hides ";
  let text = prefix;
  for (const label of labels) {
    const next = text === prefix ? `${prefix}${label}` : `${text}, ${label}`;
    if (next.length > MAX_SUMMARY) break;
    text = next;
  }
  return text === prefix ? `Quieter ${recipe.name}` : text;
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

function sqlFor(site, recipe, submittedAt) {
  const submissionId = `official-${site}-${recipe.version}`;
  return [
    `INSERT OR IGNORE INTO owners (recipe_id, token_hash, created_at) VALUES (${quote(recipe.id)}, ${quote(OFFICIAL_TOKEN_HASH)}, ${submittedAt});`,
    `INSERT OR IGNORE INTO submissions (id, recipe_id, version, status, submitted_at, release_at, summary, recipe_json, validated, channel, submitter) VALUES (${quote(submissionId)}, ${quote(recipe.id)}, ${quote(recipe.version)}, 'held', ${submittedAt}, 0, ${quote(summaryOf(recipe))}, ${quote(JSON.stringify(recipe))}, 1, 'official', NULL);`,
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sites = readdirSync(RECIPES)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
  if (options.only) {
    const unknown = options.only.filter((site) => !sites.includes(site));
    if (unknown.length > 0) fail(`no such official recipe: ${unknown.join(", ")}`);
  }
  const chosen = options.only ?? sites;
  const submittedAt = Math.floor(Date.now() / 1000);
  const statements = chosen.map((site) => {
    const recipe = JSON.parse(readFileSync(path.join(RECIPES, `${site}.json`), "utf8"));
    checked(site, recipe);
    return `-- ${recipe.id} ${recipe.version} [${recipe.tags.join(", ")}]\n${sqlFor(site, recipe, submittedAt)}`;
  });
  const header = `-- Official recipes for the OpenMedia marketplace, generated by scripts/official-recipes.mjs.\n-- Review, then run the wrangler command that printed with it. Nothing here is applied by itself.\n`;
  mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  writeFileSync(options.out, `${header}\n${statements.join("\n\n")}\n`);
  const where = options.local ? "--local" : "--remote";
  console.log(`Wrote ${chosen.length} official recipes to ${options.out}.`);
  console.log("Apply them with (from the openmedia-worker repo):");
  console.log(
    `  yarn wrangler d1 execute ${options.db} ${where} --file ${path.resolve(options.out)}`,
  );
  console.log("The next cron run validates and publishes them; check:");
  console.log(
    `  yarn wrangler d1 execute ${options.db} ${where} --command "SELECT recipe_id, version, status FROM submissions WHERE channel = 'official'"`,
  );
}

main();
