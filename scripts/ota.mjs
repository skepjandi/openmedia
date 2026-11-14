// Usage: yarn ota <command> [options]
//
//   keygen              make the two signing keys (once), print where they went
//   web                 build the web layer, sign it, publish it to the `ota` release
//   app                 build this machine's desktop installers with updater artifacts, upload
//                       them to the release for the current version, then refresh latest.json
//   manifest            rebuild latest.json for the current version from the release's assets
//   all                 web, then app
//
//   --dry-run           build and sign into release/ota/, publish nothing
//   --no-build          web: reuse dist/ instead of running `yarn build:web`
//   --target <triple>   app: a Rust target other than this machine's (e.g. x86_64-apple-darwin)
//   --no-manifest       app: leave latest.json to a later `yarn ota manifest` (CI does this, since
//                       several machines each add their own platform)
//   --notes "text"      app, manifest: the release notes shown by the updater
//   --force             keygen: replace existing keys (every installed app then rejects updates)
//   --github            keygen: also store the keys as this repository's GitHub secrets
//
// Two kinds of update, two keys (see docs/wiki/updates.md):
//   web      the React shell, for every platform, verified by the app against
//            src-tauri/ota-public-key.txt. Key: OPENMEDIA_OTA_KEY (base64), else <keys>/web.key
//   app      the desktop binary, through tauri-plugin-updater and a Minisign key. Key:
//            TAURI_SIGNING_PRIVATE_KEY (text or path), else <keys>/updater.key; its password, if
//            it has one, in TAURI_SIGNING_PRIVATE_KEY_PASSWORD
// <keys> is ~/.openmedia/ota, or OPENMEDIA_OTA_KEY_DIR. Settings may also live in ../.env.
// Publishing needs the GitHub CLI (`gh auth login`), or GH_TOKEN in CI. The repository is the
// `repository` of src-tauri/Cargo.toml, or OTA_REPO.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./lib/env.mjs";
import {
  UPDATER_ARTIFACT,
  buildLatestJson,
  bundleName,
  collectFiles,
  generateSigningKey,
  openBundle,
  packBundle,
  platformKey,
  pointerFor,
  pointerName,
  publicKeyOf,
  releaseAssetName,
} from "./lib/ota-bundle.mjs";
import { releaseNotes, releaseTitle } from "./lib/release-notes.mjs";

const root = path.resolve(import.meta.dirname, "..");
const tauriDir = path.join(root, "src-tauri");
const publicKeyFile = path.join(tauriDir, "ota-public-key.txt");
const overlayFile = path.join(tauriDir, "tauri.ota.conf.json");
const OTA_TAG = "ota";
const KEEP_BUNDLES = 3;

const env = loadEnv(root);
const [command, ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const fail = (message) => {
  console.error(`ota: ${message}`);
  process.exit(1);
};

const run = (cmd, cmdArgs, options = {}) => {
  console.log(`\n$ ${[cmd, ...cmdArgs].join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: "inherit",
    ...options,
    env: { ...env, ...options.env },
  });
  if (result.status !== 0) fail(`${cmd} ${cmdArgs[0] ?? ""} failed (exit ${result.status})`);
};

/** Runs a command and returns its output; null when it exits non-zero. */
const capture = (cmd, cmdArgs) => {
  const result = spawnSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", env });
  return result.status === 0 ? result.stdout : null;
};

// ---- project facts ----

const version = JSON.parse(fs.readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8")).version;

function repository() {
  if (env.OTA_REPO) return env.OTA_REPO;
  const cargo = fs.readFileSync(path.join(tauriDir, "Cargo.toml"), "utf8");
  const match = cargo.match(/^repository\s*=\s*"https:\/\/github\.com\/([^"/]+\/[^"/]+?)"/m);
  return match?.[1] ?? fail("src-tauri/Cargo.toml has no GitHub `repository`; set OTA_REPO");
}

const keyDir = () => env.OPENMEDIA_OTA_KEY_DIR || path.join(os.homedir(), ".openmedia/ota");

const gh = (...ghArgs) => run("gh", [...ghArgs, "--repo", repository()]);
const ghOutput = (...ghArgs) => capture("gh", [...ghArgs, "--repo", repository()]);

function otaRelease(revision) {
  const { title, notes } = changes();
  const date = new Date().toISOString().slice(0, 10);
  return {
    title: `${title} (web update)`,
    notes: [
      `Web update for **OpenMedia ${version}**, revision ${revision}, ${date}.`,
      "",
      "The assets here are signed web-layer bundles that installed apps fetch and verify by themselves, so the interface updates without a store release. They are not an app download. Managed by `yarn ota`; do not edit the assets.",
      "",
      notes,
    ].join("\n"),
  };
}

/** Title and notes for this version, from the commits since the previous v* release tag. */
function changes() {
  const tags = (capture("git", ["tag", "--list", "v*", "--sort=-v:refname"]) ?? "")
    .split("\n")
    .filter((tag) => tag && tag !== `v${version}`);
  const previousTag = tags[0];
  const range = previousTag ? [`${previousTag}..HEAD`] : ["--max-count=60"];
  const subjects = (capture("git", ["log", "--no-merges", "--format=%s", ...range]) ?? "")
    .split("\n")
    .filter(Boolean);
  return {
    title: releaseTitle(version, subjects),
    notes: releaseNotes({ version, previousTag, subjects, repository: repository() }),
  };
}

function ensureRelease(tag, { title, notes, prerelease }) {
  if (ghOutput("release", "view", tag) !== null) return;
  const target = tag.startsWith("v")
    ? ["--target", capture("git", ["rev-parse", "HEAD"]).trim()]
    : [];
  gh(
    "release",
    "create",
    tag,
    "--title",
    title,
    "--notes",
    notes,
    ...target,
    prerelease ? "--prerelease" : "--latest",
  );
}

const upload = (tag, files) => gh("release", "upload", tag, ...files, "--clobber");

// ---- keygen ----

function keygen() {
  const dir = keyDir();
  const webKey = path.join(dir, "web.key");
  const updaterKey = path.join(dir, "updater.key");
  if ((fs.existsSync(webKey) || fs.existsSync(updaterKey)) && !flag("--force"))
    fail(
      `keys already exist in ${dir}. Replacing them locks out every installed app; use --force if you mean it`,
    );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const web = generateSigningKey();
  fs.writeFileSync(webKey, `${web.privateKey}\n`, { mode: 0o600 });
  fs.writeFileSync(publicKeyFile, `${web.publicKey}\n`);

  fs.rmSync(updaterKey, { force: true });
  fs.rmSync(`${updaterKey}.pub`, { force: true });
  const password = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  // The password is passed by environment, not on the command line (which `run` prints).
  run("yarn", ["tauri", "signer", "generate", "--ci", "--write-keys", updaterKey], {
    env: { TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
  });
  const overlay = JSON.parse(fs.readFileSync(overlayFile, "utf8"));
  overlay.plugins.updater.pubkey = fs.readFileSync(`${updaterKey}.pub`, "utf8").trim();
  fs.writeFileSync(overlayFile, `${JSON.stringify(overlay, null, 2)}\n`);

  if (flag("--github")) {
    const secrets = {
      OPENMEDIA_OTA_KEY: fs.readFileSync(webKey, "utf8").trim(),
      TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(updaterKey, "utf8").trim(),
    };
    // GitHub refuses an empty secret; an unset one reads as empty in a workflow, which is right.
    if (password) secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
    // The value goes in on stdin: it would otherwise be printed with the command line and show in
    // the process list.
    for (const [name, value] of Object.entries(secrets)) {
      console.log(`\n$ gh secret set ${name} --repo ${repository()}`);
      const result = spawnSync("gh", ["secret", "set", name, "--repo", repository()], {
        cwd: root,
        input: value,
        stdio: ["pipe", "inherit", "inherit"],
        env,
      });
      if (result.status !== 0) fail(`gh secret set ${name} failed (exit ${result.status})`);
    }
  }

  console.log(`
ota: private keys are in ${dir}. Back them up; they are not in the repository and cannot be
recovered. Commit the public halves, which this just wrote:
  ${path.relative(root, publicKeyFile)}
  ${path.relative(root, overlayFile)}`);
}

// ---- web ----

function webKey() {
  const key = env.OPENMEDIA_OTA_KEY || readIfExists(path.join(keyDir(), "web.key"));
  return key?.trim() || fail("no web key: run `yarn ota keygen` or set OPENMEDIA_OTA_KEY");
}

function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function publishWeb() {
  const privateKey = webKey();
  const publicKey = fs.readFileSync(publicKeyFile, "utf8").trim();
  if (publicKeyOf(privateKey) !== publicKey)
    fail(
      "the web key does not match src-tauri/ota-public-key.txt, so no installed app would accept this bundle",
    );

  if (!flag("--no-build")) run("yarn", ["build:web"]);
  const dist = path.join(root, "dist");
  if (!fs.existsSync(dist)) fail("dist/ does not exist; build the web layer first");

  const revision = Math.floor(Date.now() / 1000);
  const packed = packBundle({
    files: collectFiles(dist),
    runtimeVersion: version,
    revision,
    privateKey,
  });
  openBundle(packed, publicKey);

  const out = path.join(root, "release/ota", `web-${version}-${revision}`);
  fs.mkdirSync(out, { recursive: true });
  const bundleFile = path.join(out, bundleName(version, revision));
  const pointerFile = path.join(out, pointerName(version));
  fs.writeFileSync(bundleFile, packed);
  fs.writeFileSync(
    pointerFile,
    JSON.stringify(pointerFor({ runtimeVersion: version, revision, size: packed.length })),
  );
  console.log(`ota: web bundle for app ${version}, revision ${revision}, ${packed.length} bytes`);
  if (flag("--dry-run"))
    return console.log(`ota: dry run, nothing published (${path.relative(root, out)})`);

  const { title, notes } = otaRelease(revision);
  ensureRelease(OTA_TAG, { title, notes, prerelease: true });
  gh("release", "edit", OTA_TAG, "--title", title, "--notes", notes);
  // The bundle first: the pointer is what makes an app look for it.
  upload(OTA_TAG, [bundleFile]);
  upload(OTA_TAG, [pointerFile]);
  pruneBundles();
}

function pruneBundles() {
  const listing = ghOutput("release", "view", OTA_TAG, "--json", "assets");
  if (listing === null) return;
  const mine = new RegExp(`^bundle-${version.replaceAll(".", "\\.")}-(\\d+)\\.ota$`);
  const stale = JSON.parse(listing)
    .assets.map((asset) => asset.name)
    .filter((name) => mine.test(name))
    .sort((a, b) => Number(b.match(mine)[1]) - Number(a.match(mine)[1]))
    .slice(KEEP_BUNDLES);
  for (const name of stale) gh("release", "delete-asset", OTA_TAG, name, "--yes");
}

// ---- app ----

function hostTriple() {
  const info = capture("rustc", ["-vV"]) ?? fail("rustc is not installed");
  return info.match(/^host: (.+)$/m)?.[1] ?? fail("could not read the host target from rustc");
}

function updaterKeyEnv() {
  const given = env.TAURI_SIGNING_PRIVATE_KEY;
  const file = path.join(keyDir(), "updater.key");
  if (!given && !fs.existsSync(file))
    fail("no updater key: run `yarn ota keygen` or set TAURI_SIGNING_PRIVATE_KEY");
  return {
    TAURI_SIGNING_PRIVATE_KEY: given || file,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
  };
}

function findFiles(dir, pattern) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));
}

const BUNDLES = { darwin: "app,dmg", windows: "nsis", linux: "appimage" };

function buildApp() {
  const triple = option("--target") ?? hostTriple();
  const key = platformKey(triple);
  const system = key.split("-")[0];
  run(
    "yarn",
    [
      "tauri",
      "build",
      "--config",
      path.relative(root, overlayFile),
      "--features",
      "self-update",
      "--bundles",
      BUNDLES[system],
      ...(option("--target") ? ["--target", triple] : []),
    ],
    { env: updaterKeyEnv() },
  );

  const targetRoot = env.CARGO_TARGET_DIR
    ? path.resolve(env.CARGO_TARGET_DIR)
    : path.join(tauriDir, "target");
  const bundleDir = path.join(targetRoot, option("--target") ? triple : "", "release/bundle");
  const artifact = findFiles(bundleDir, UPDATER_ARTIFACT[system]).find((file) =>
    fs.existsSync(`${file}.sig`),
  );
  if (!artifact)
    fail(
      `the build left no signed updater artifact under ${bundleDir} (is TAURI_SIGNING_PRIVATE_KEY the key the config trusts?)`,
    );

  const out = path.join(root, "release/ota", `app-${version}-${key}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const extension = artifact.match(/(app\.tar\.gz|exe|AppImage)$/)[1];
  const updaterName = releaseAssetName(version, key, extension);
  fs.copyFileSync(artifact, path.join(out, updaterName));
  fs.copyFileSync(`${artifact}.sig`, path.join(out, `${updaterName}.sig`));
  for (const dmg of findFiles(bundleDir, /\.dmg$/))
    fs.copyFileSync(dmg, path.join(out, releaseAssetName(version, key, "dmg")));
  return fs.readdirSync(out).map((name) => path.join(out, name));
}

function publishApp() {
  const files = buildApp();
  console.log(`ota: built ${files.map((file) => path.basename(file)).join(", ")}`);
  if (flag("--dry-run")) return console.log("ota: dry run, nothing published");
  const { title, notes } = changes();
  ensureRelease(`v${version}`, { title, notes: option("--notes") ?? notes });
  upload(`v${version}`, files);
  if (!flag("--no-manifest")) publishManifest();
}

// ---- latest.json ----

function publishManifest() {
  const tag = `v${version}`;
  const listing =
    ghOutput("release", "view", tag, "--json", "assets") ??
    fail(`there is no release ${tag}; run \`yarn ota app\` first`);
  const assetNames = JSON.parse(listing).assets.map((asset) => asset.name);
  const signatures = new Map();
  for (const name of assetNames.filter((n) => n.endsWith(".sig")))
    signatures.set(
      name,
      ghOutput("release", "download", tag, "--pattern", name, "--output", "-") ??
        fail(`could not download ${name}`),
    );

  const latest = buildLatestJson({
    version,
    notes: option("--notes") ?? changes().notes,
    pubDate: new Date().toISOString(),
    downloadBase: `https://github.com/${repository()}/releases/download/${tag}`,
    assetNames,
    signatures,
  });
  if (Object.keys(latest.platforms).length === 0)
    fail(`release ${tag} has no signed desktop installers`);

  const out = path.join(root, "release/ota");
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, "latest.json");
  fs.writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`ota: latest.json covers ${Object.keys(latest.platforms).join(", ")}`);
  if (flag("--dry-run")) return;
  upload(tag, [file]);
}

// ---- main ----

const commands = {
  keygen,
  web: publishWeb,
  app: publishApp,
  manifest: publishManifest,
  all: () => {
    publishWeb();
    publishApp();
  },
};

if (command in commands) commands[command]();
else
  fail(`unknown command "${command ?? ""}". Usage: yarn ota keygen|web|app|manifest|all [options]`);
