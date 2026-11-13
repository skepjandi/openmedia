#!/usr/bin/env node
/**
 * Fetches the icon of every official recipe's site and bundles it with the app.
 *
 * The recipes are the only source of truth: the script reads `recipes/official/*.json`, takes each
 * recipe's homepage and the domains its match patterns cover, and asks that site for its own
 * icon. Nothing else is contacted: an icon comes from the site's own page or from the site's own
 * CDN, never from an icon service, so the app keeps its promise of talking to no third party.
 *
 * The result is committed: `src/assets/site-icons/` holds one PNG per recipe and
 * `src/shared/bundledSiteIcons.ts` maps the site's domains to it. The app reads those files
 * offline; the network is only used when this script runs. The manifest beside the icons says
 * where each one came from, and is the cache: a run that finds it needs no network at all.
 *
 * Turning what a site serves into a PNG needs an image tool: sips on macOS, ImageMagick
 * (`magick` or `convert`) anywhere else. The script uses whichever it finds.
 *
 *   node scripts/fetch-site-icons.mjs              # fill in what is missing
 *   node scripts/fetch-site-icons.mjs --force      # fetch every icon again
 *   node scripts/fetch-site-icons.mjs --site reddit
 *   node scripts/fetch-site-icons.mjs --probe      # report, write nothing
 *   node scripts/fetch-site-icons.mjs --site kuaishou --source <url>
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { format, resolveConfig } from "prettier";
import { createMatcher } from "../shared/public-suffix/match.mjs";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECIPES = path.join(ROOT, "recipes", "official");
const ASSETS = path.join(ROOT, "src", "assets", "site-icons");
const MANIFEST = path.join(ASSETS, "manifest.json");
const GENERATED = path.join(ROOT, "src", "shared", "bundledSiteIcons.ts");

/** The size of a bundled icon, in pixels. The app shows them at most 40 points wide. */
const ICON_SIZE = 96;
const MAX_BYTES = 400_000;
const MAX_CANDIDATES = 12;
const TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** The domain a host belongs to: `www.instagram.com` and `m.instagram.com` both give
 * `instagram.com`. A host without a registrable part is kept whole. */
const registrable = createMatcher(
  readFileSync(
    path.join(ROOT, "shared", "public-suffix", "resources", "public_suffix_rules.txt"),
    "utf8",
  ),
);
function registrableDomain(host) {
  return registrable(host) ?? host.toLowerCase();
}

/** The host a match pattern covers: `https://*.discord.com/*` covers `discord.com`. */
function hostOfPattern(pattern) {
  const host = pattern
    .replace(/^[a-z]+:\/\//i, "")
    .split("/")[0]
    .toLowerCase();
  return host.replace(/^\*\./, "");
}

/**
 * Services that hand out other people's icons. The app never asks one of them for an icon: a
 * site's icon is its own file, even when it lives on the site's own CDN. A service's own domain
 * is allowed for the site that owns it: google.com's icon is a file of google.com.
 */
const ICON_SERVICES = [
  "google.com",
  "gstatic.com",
  "duckduckgo.com",
  "faviconkit.com",
  "favicon.dev",
  "iconfinder.com",
  "iconscout.com",
  "logo.dev",
];

function isIconService(url, owned = new Set()) {
  const host = url.hostname.toLowerCase();
  return ICON_SERVICES.some(
    (service) => (host === service || host.endsWith(`.${service}`)) && !owned.has(service),
  );
}

async function get(url, attempts = 1, owned) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await getOnce(url, owned);
    if (found) return found;
  }
  return null;
}

async function getOnce(url, owned) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let target = new URL(url);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!["http:", "https:"].includes(target.protocol) || isIconService(target, owned)) {
        return null;
      }
      const response = await fetch(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "*/*" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) return null;
        target = new URL(location, target);
        continue;
      }
      if (!response.ok) return null;
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) return null;
      return { bytes, url: response.url };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The file extension of an address, so a native converter can guess the format. */
function extensionOf(url) {
  const name = url.pathname.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return match ? match[1] : null;
}

/** The icon links of a page, touch icons first: they are the ones a site made for phones. */
function iconLinks(html, base) {
  const touch = [];
  const plain = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attribute(tag, "rel");
    const href = attribute(tag, "href");
    if (!rel || !href || !rel.toLowerCase().includes("icon")) continue;
    let url;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (rel.toLowerCase().includes("apple-touch-icon")) touch.push(url);
    else plain.push(url);
  }
  return [...touch, ...plain];
}

/** The icons a web app manifest lists, biggest first: the ones a site made for home screens. */
async function manifestIcons(html, base, owned) {
  const link = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((tag) => attribute(tag, "rel")?.toLowerCase() === "manifest");
  const href = link ? attribute(link, "href") : null;
  if (!href) return [];
  let manifestUrl;
  try {
    manifestUrl = new URL(href, base);
  } catch {
    return [];
  }
  const found = await get(manifestUrl, 1, owned);
  if (!found) return [];
  try {
    const icons = JSON.parse(found.bytes.toString("utf8")).icons ?? [];
    const side = (icon) => Number(String(icon.sizes ?? "").split(/[x\s]/)[0]) || 0;
    return icons
      .filter((icon) => typeof icon.src === "string")
      .sort((a, b) => side(b) - side(a))
      .slice(0, 2)
      .map((icon) => new URL(icon.src, found.url));
  } catch {
    return [];
  }
}

/** The Windows tile image a page names, when it names one. */
function tileImage(html, base) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(match[0], "name")?.toLowerCase() !== "msapplication-tileimage") continue;
    const content = attribute(match[0], "content");
    if (!content) continue;
    try {
      return [new URL(content, base)];
    } catch {
      return [];
    }
  }
  return [];
}

/** The pages to read icon links from: the homepage, then the bare and `www.` forms of its domain. */
function pagesOf(site) {
  const home = new URL(site.homepage);
  const domain = registrableDomain(home.hostname);
  const others = [`https://${domain}/`, `https://www.${domain}/`];
  return [home.toString(), ...others.filter((url) => url !== home.toString())];
}

/** The icon of one site: the first of its own icon files that can be read. */
async function findIcon(site, sources, log) {
  // A site may fetch from its own domain even where an icon service shares it (google.com).
  const owned = new Set(site.domains);
  const candidates = [];
  let base = new URL(site.homepage);
  for (const address of pagesOf(site)) {
    const page = await get(address, address === site.homepage ? 3 : 1, owned);
    if (!page) continue;
    const html = page.bytes.toString("utf8");
    base = new URL(page.url);
    candidates.push(...iconLinks(html, page.url));
    candidates.push(...(await manifestIcons(html, page.url, owned)));
    candidates.push(...tileImage(html, page.url));
    break;
  }
  for (const path of [
    "/apple-touch-icon.png",
    "/apple-touch-icon-precomposed.png",
    "/favicon.ico",
    "/favicon.png",
    "/favicon.svg",
  ]) {
    candidates.push(new URL(path, base));
  }
  for (const source of sources) {
    try {
      candidates.push(new URL(source));
    } catch {
      log(`    skipped ${source} (not an address)`);
    }
  }
  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.size >= MAX_CANDIDATES) break;
    const key = candidate.toString();
    if (tried.has(key)) continue;
    tried.add(key);
    if (isIconService(candidate, owned)) {
      log(`    skipped ${key} (a third-party icon service)`);
      continue;
    }
    const found = await get(candidate, 1, owned);
    if (!found) continue;
    if (isIconService(new URL(found.url), owned)) {
      log(`    skipped ${key} (led to a third-party icon service)`);
      continue;
    }
    const converted = await toPng(found.bytes, extensionOf(candidate));
    if (!converted) {
      log(`    skipped ${key} (not an image this can read)`);
      continue;
    }
    return { bytes: converted, source: found.url };
  }
  return null;
}

/** The converters that turn an icon into a PNG, in the order they are tried. */
const CONVERTERS = [
  {
    command: "sips",
    args: (input, output) => [
      "-Z",
      String(ICON_SIZE),
      "-s",
      "format",
      "png",
      input,
      "--out",
      output,
    ],
  },
  {
    command: "magick",
    args: (input, output) => [
      input,
      "-resize",
      `${ICON_SIZE}x${ICON_SIZE}`,
      "-background",
      "none",
      "-gravity",
      "center",
      "-extent",
      `${ICON_SIZE}x${ICON_SIZE}`,
      `PNG32:${output}`,
    ],
  },
  {
    command: "convert",
    args: (input, output) => [
      input,
      "-resize",
      `${ICON_SIZE}x${ICON_SIZE}`,
      "-background",
      "none",
      "-gravity",
      "center",
      "-extent",
      `${ICON_SIZE}x${ICON_SIZE}`,
      `PNG32:${output}`,
    ],
  },
];

/** The size of a PNG, so the script can tell a real icon from a broken file. */
function pngSize(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Turns an icon into a PNG of at most `ICON_SIZE` pixels, using the image tool the machine has:
 * sips on macOS, ImageMagick elsewhere. Returns null when no tool can read the file.
 */
async function toPng(bytes, extension) {
  const folder = await mkdtemp(path.join(tmpdir(), "openmedia-icon-"));
  const input = path.join(folder, `icon${extension || ".png"}`);
  const output = path.join(folder, "icon.png");
  try {
    await writeFile(input, bytes);
    for (const converter of CONVERTERS) {
      try {
        await run(converter.command, converter.args(input, output), { timeout: 20_000 });
        const png = await readFile(output);
        if (pngSize(png)) return png;
      } catch {
        // the converter is not installed, or it cannot read this file
      }
    }
    return null;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function readSites() {
  const files = (await readdir(RECIPES)).filter((file) => file.endsWith(".json")).sort();
  const sites = [];
  for (const file of files) {
    const recipe = JSON.parse(await readFile(path.join(RECIPES, file), "utf8"));
    const homepage = recipe.meta?.homepage;
    if (!homepage) {
      console.warn(`${file} has no homepage; skipped`);
      continue;
    }
    const domains = new Set();
    for (const pattern of recipe.match ?? []) {
      const host = hostOfPattern(pattern);
      if (host) domains.add(registrableDomain(host));
    }
    domains.add(registrableDomain(new URL(homepage).hostname));
    sites.push({
      id: recipe.id,
      name: recipe.name,
      slug: file.replace(/\.json$/, ""),
      homepage,
      domains: [...domains].sort(),
    });
  }
  return sites;
}

async function readManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    return { sites: {} };
  }
}

/**
 * The cached entry for a site's icon, whichever recipe id it was stored under. The manifest is
 * keyed by the recipe id, but an id changes when a recipe is renamed or republished; the icon
 * file is named after the recipe file, so the same icon is still found by its file name.
 */
function cachedByFile(manifest, site) {
  const file = `${site.slug}.png`;
  return Object.values(manifest.sites ?? {}).find((entry) => entry.file === file);
}

/** The identifier an icon is imported under: the slug with its dashes turned into camel case. */
function identifierOf(slug) {
  const identifier = slug.replace(/-([a-z0-9])/g, (_, character) => character.toUpperCase());
  return /^[a-z_$]/i.test(identifier) ? identifier : `icon${identifier}`;
}

/** The name a domain has: the part before the first dot. */
function labelOf(domain) {
  return domain.split(".")[0];
}

/**
 * True when the site is named after the domain: `whatsapp` owns `whatsapp.com`. A site that
 * covers other sites' domains (a hub) owns none of them and does not take their icons.
 */
function ownsDomain(site, domain) {
  return labelOf(domain) === site.slug;
}

function generatedModule(sites) {
  // A site that owns a domain keeps it; the others fill what is left, in the order they are read.
  const owners = sites.filter((site) => site.domains.some((domain) => ownsDomain(site, domain)));
  const rest = sites.filter((site) => !owners.includes(site));
  const imports = [];
  const entries = [];
  const claimed = new Set();
  for (const site of [...owners, ...rest]) {
    const domains = site.domains.filter((domain) => !claimed.has(domain));
    if (domains.length === 0) continue;
    for (const domain of domains) claimed.add(domain);
    imports.push(`import ${identifierOf(site.slug)} from "../assets/site-icons/${site.slug}.png";`);
    entries.push(...domains.map((domain) => `  "${domain}": ${identifierOf(site.slug)},`));
  }
  return `// Generated by scripts/fetch-site-icons.mjs. Do not edit by hand.
//
// Every icon was fetched from the site's own files, never from an icon service. Run the script
// again to refresh them; the sources are listed in src/assets/site-icons/manifest.json.

${imports.join("\n")}

/** The icons that ship with the app, by the domain of the site they belong to. */
export const BUNDLED_ICON_BY_DOMAIN: Record<string, string> = {
${entries.join("\n")}
};
`;
}

/** How long a site that offered no icon is left alone, so a build does not ask it again at once. */
const MISS_TTL_DAYS = 30;
const CONCURRENCY = 8;

/** Runs `work` on every item, at most `limit` at a time, and returns the results in order. */
async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** An icon file already on disk, converted like a downloaded one; `source` says where it came from. */
async function fromLocalFile(file, source) {
  const bytes = await toPng(await readFile(file), path.extname(file).toLowerCase());
  return bytes ? { bytes, source: source ?? file } : null;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const probe = args.includes("--probe");
  const retry = args.includes("--retry");
  const strict = args.includes("--strict");
  const only = args.includes("--site") ? args[args.indexOf("--site") + 1] : null;
  const given = args.includes("--source") ? args[args.indexOf("--source") + 1] : null;
  // `--site <slug> --file <path> --source <url>`: an icon a browser took from the site's own page,
  // for the sites that turn a script away. It still goes through the same conversion.
  const fromFile = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

  const sites = (await readSites()).filter(
    (site) => !only || site.slug === only || site.id === only,
  );
  const manifest = await readManifest();
  const missingSince = manifest.missing ?? {};
  const now = Date.now();
  const recentMiss = (site) => {
    const at = Date.parse(missingSince[site.id] ?? "");
    return !Number.isNaN(at) && now - at < MISS_TTL_DAYS * 86_400_000;
  };

  const outcomes = await pool(sites, CONCURRENCY, async (site) => {
    const lines = [];
    const log = (message) => lines.push(message);
    const cached = manifest.sites?.[site.id] ?? cachedByFile(manifest, site);
    const file = path.join(ASSETS, `${site.slug}.png`);
    if (!force && !given && cached?.file) {
      try {
        const bytes = await readFile(file);
        return { site, lines, entry: { ...cached, bytes: bytes.length } };
      } catch {
        // the file is gone; fetch it again
      }
    }
    if (!force && !given && !retry && !only && recentMiss(site)) {
      return { site, lines, skipped: true };
    }
    log(`${site.name}: fetching from ${site.homepage}`);
    const sources = [given, cached?.source].filter((source) => Boolean(source));
    const found = fromFile
      ? await fromLocalFile(fromFile, given)
      : await findIcon(site, sources, log);
    if (!found) {
      log(`${site.name}: no icon found`);
      return { site, lines, missed: true };
    }
    if (!probe) {
      await mkdir(ASSETS, { recursive: true });
      await writeFile(file, found.bytes);
    }
    log(`  ${found.source} -> ${site.slug}.png (${found.bytes.length} bytes)`);
    return {
      site,
      lines,
      entry: {
        file: `${site.slug}.png`,
        source: found.source,
        domains: site.domains,
        bytes: found.bytes.length,
        sha256: createHash("sha256").update(found.bytes).digest("hex"),
      },
    };
  });

  for (const { lines } of outcomes) for (const line of lines) console.log(line);
  const missed = outcomes.filter((outcome) => outcome.missed).map(({ site }) => site);
  const skipped = outcomes.filter((outcome) => outcome.skipped).map(({ site }) => site);

  if (probe) {
    const found = outcomes.filter((outcome) => outcome.entry).length;
    console.log(
      `\n${found} icon(s) found, ${missed.length} missing, ${skipped.length} skipped as recent misses.`,
    );
    return;
  }

  const byId = new Map();
  for (const { site, entry } of outcomes) {
    if (entry) {
      byId.set(site.id, entry);
      continue;
    }
    const previous = manifest.sites?.[site.id];
    if (previous?.file && existsSync(path.join(ASSETS, previous.file))) {
      byId.set(site.id, previous);
    }
  }

  // A run limited to one site must not forget the rest of the library.
  const inRun = new Set(sites.map((site) => site.id));
  for (const [id, entry] of Object.entries(manifest.sites ?? {})) {
    if (!inRun.has(id) && !byId.has(id)) byId.set(id, entry);
  }
  const misses = Object.fromEntries(
    Object.entries(missingSince).filter(([id]) => !inRun.has(id) && !byId.has(id)),
  );
  for (const site of missed) misses[site.id] = new Date(now).toISOString();
  for (const site of skipped) misses[site.id] = missingSince[site.id];

  await mkdir(ASSETS, { recursive: true });
  await writeFile(
    MANIFEST,
    await format(JSON.stringify({ sites: Object.fromEntries(byId), missing: misses }), {
      ...(await resolveConfig(MANIFEST)),
      parser: "json",
    }),
  );
  const all = await readSites();
  await writeFile(GENERATED, generatedModule(all.filter((site) => byId.has(site.id))));

  console.log(`\n${byId.size} icon(s) in src/assets/site-icons/.`);
  const without = [...missed, ...skipped];
  if (without.length > 0) {
    // A site with no icon file of its own is not an error: the app draws its monogram, or the
    // icon the site serves when the reader opens it.
    console.warn(
      `${without.length} site(s) offer no icon of their own: ${without.map((site) => site.slug).join(", ")}`,
    );
    if (strict) process.exitCode = 1;
  }
}

await main();
