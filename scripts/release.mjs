// OpenMedia release CLI. Run `yarn release help` for the commands.
//
//   yarn release doctor [ios] [android] [macos]   check everything a release needs, with fixes
//   yarn release setup                            import certificates/profiles from the signing folder
//   yarn release [build] [ios] [android] [macos]  build the store packages into release/<version>-<build>/
//   yarn release bump <patch|minor|major|x.y.z>   raise the version and build number (files only)
//   yarn release ship <patch|minor|major|x.y.z>   doctor, bump through a PR, merge, then build
//
// Signing identities and profiles are discovered (scripts/lib/signing.mjs); any of them can still be
// forced with IOS_SIGN_IDENTITY, IOS_PROFILE, MAS_APP_IDENTITY, MAS_INSTALLER_IDENTITY, MAS_PROFILE,
// APPLE_TEAM_ID in the environment or .env. Full guide: docs/wiki/store-builds.md.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { loadEnv } from "./lib/env.mjs";
import {
  BUNDLE_ID,
  findProfiles,
  importCertificates,
  installIosProfile,
  resolveSigning,
  signingDir,
} from "./lib/signing.mjs";
import {
  addChangelogEntry,
  nextVersion,
  readBuilds,
  readVersions,
  versionFiles,
  writeBuild,
  writeVersion,
} from "./lib/version.mjs";

const root = path.resolve(import.meta.dirname, "..");
const PLATFORMS = ["ios", "android", "macos"];
const COMMANDS = ["help", "doctor", "setup", "build", "bump", "ship"];

const args = process.argv.slice(2);
const command = COMMANDS.includes(args[0]) ? args[0] : "build";
const rest = COMMANDS.includes(args[0]) ? args.slice(1) : args;
const flag = (name) => rest.includes(name);
const valueOf = (name) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : null;
};
const explicitBuild = valueOf("--build") === null ? null : Number(valueOf("--build"));
const wanted = rest.filter((a) => PLATFORMS.includes(a));
const platforms = wanted.length ? wanted : PLATFORMS;

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const env = loadEnv(root);

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

const capture = (cmd, cmdArgs, cwd = root) => {
  const result = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
};

// ---- App Store Connect (optional) ----
const ascConfigured = () => env.ASC_KEY_ID && env.ASC_ISSUER_ID && env.ASC_KEY_PATH;

function ascToken() {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = part({ alg: "ES256", kid: env.ASC_KEY_ID, typ: "JWT" });
  const body = part({
    iss: env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  });
  const key = fs.readFileSync(env.ASC_KEY_PATH.replace(/^~/, os.homedir()));
  const signature = crypto.sign("sha256", Buffer.from(`${head}.${body}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${body}.${signature.toString("base64url")}`;
}

async function asc(pathAndQuery) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${ascToken()}` },
  });
  if (!response.ok) throw new Error(`App Store Connect ${response.status} for ${pathAndQuery}`);
  return response.json();
}

/** The largest numeric build number App Store Connect holds for the app, or 0. */
async function highestAppleBuild() {
  const apps = await asc(`/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = apps.data[0];
  if (!app) return 0;
  let highest = 0;
  let next = `/v1/builds?filter[app]=${app.id}&limit=200`;
  while (next) {
    const page = await asc(next.replace("https://api.appstoreconnect.apple.com", ""));
    for (const build of page.data) {
      const number = Number(build.attributes.version);
      if (Number.isInteger(number)) highest = Math.max(highest, number);
    }
    next = page.links?.next ?? null;
  }
  return highest;
}

// ---- build number ----
/** The next build number: one above the tauri.conf.json numbers and App Store Connect's latest. */
async function nextBuild(dir) {
  let known = Math.max(...readBuilds(dir));
  if (ascConfigured()) {
    try {
      known = Math.max(known, await highestAppleBuild());
    } catch (error) {
      console.warn(`release: ${error.message}; using the number in tauri.conf.json`);
    }
  } else {
    console.warn(
      "release: no ASC_* settings, so App Store Connect was not asked for its latest build",
    );
  }
  return known + 1;
}

// ---- doctor ----
const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** Every check a release needs for `targets`. Each: { level: ok|warn|fail, label, detail, fix }. */
function runChecks(targets, dir = root) {
  const checks = [];
  const add = (level, label, detail = "", fix = "") => checks.push({ level, label, detail, fix });
  const has = (cmd, cmdArgs = ["--version"]) =>
    spawnSync(cmd, cmdArgs, { stdio: "ignore" }).status === 0;

  // Version and build numbers.
  const versions = readVersions(dir);
  if (versions.pkg && versions.pkg === versions.conf) add("ok", "version", versions.pkg);
  else {
    add(
      "fail",
      "version",
      `package.json ${versions.pkg}, tauri.conf.json ${versions.conf}`,
      "yarn release bump <version> (keeps both in step)",
    );
  }
  const builds = readBuilds(dir);
  if (new Set(builds).size === 1) add("ok", "build number", String(builds[0]));
  else
    add(
      "warn",
      "build number",
      `iOS/macOS/Android differ: ${builds.join("/")}`,
      "the next build run sets them all to one number",
    );

  // Git state matters only for `ship`, which builds from main.
  const branch = capture("git", ["branch", "--show-current"], dir).out;
  const dirty = capture("git", ["status", "--porcelain"], dir).out;
  add(
    command === "ship" && (branch !== "main" || dirty) ? "fail" : "ok",
    "git",
    `${branch || "detached"}${dirty ? ", uncommitted changes" : ", clean"}`,
    command === "ship" ? "run ship from a clean main (commit or stash first)" : "",
  );

  const signing = resolveSigning(env);
  const wantsApple = targets.includes("ios") || targets.includes("macos");
  if (wantsApple) {
    add(
      signing.team ? "ok" : "fail",
      "Apple team",
      signing.team ?? "none found",
      "import the certificates (yarn release setup) or set APPLE_TEAM_ID",
    );
  }

  if (targets.includes("ios")) {
    add(
      has("xcodebuild", ["-version"]) ? "ok" : "fail",
      "Xcode",
      "",
      "install Xcode and run it once",
    );
    add(
      signing.iosIdentity ? "ok" : "fail",
      "iOS certificate",
      signing.iosIdentity ?? "no iPhone/Apple Distribution identity in the keychain",
      `put ios_dist.p12 in ${signingDir(env)}, set SIGNING_P12_PASSWORD in .env, run yarn release setup`,
    );
    add(
      signing.iosProfile ? "ok" : "fail",
      "iOS App Store profile",
      signing.iosProfile
        ? `${signing.iosProfile.name}${signing.iosProfile.expires ? ` (expires ${signing.iosProfile.expires.toISOString().slice(0, 10)})` : ""}`
        : "none valid for surf.openmedia",
      `download an App Store profile for ${BUNDLE_ID} into ${signingDir(env)} (docs/wiki/store-builds.md#signing-material)`,
    );
  }

  if (targets.includes("macos")) {
    add(
      signing.macApp ? "ok" : "fail",
      "Mac app certificate",
      signing.macApp ?? "no Mac App Distribution identity in the keychain",
      `put mac_app.p12 in ${signingDir(env)}, set SIGNING_P12_PASSWORD in .env, run yarn release setup`,
    );
    add(
      signing.macInstaller ? "ok" : "fail",
      "Mac installer certificate",
      signing.macInstaller ?? "no Mac Installer Distribution identity in the keychain",
      `put mac_inst.p12 in ${signingDir(env)}, set SIGNING_P12_PASSWORD in .env, run yarn release setup`,
    );
    add(
      signing.macProfile ? "ok" : "fail",
      "Mac App Store profile",
      signing.macProfile
        ? `${signing.macProfile.name}${signing.macProfile.expires ? ` (expires ${signing.macProfile.expires.toISOString().slice(0, 10)})` : ""}`
        : "none valid for surf.openmedia",
      `download a Mac App Store profile (.provisionprofile) into ${signingDir(env)}`,
    );
  }

  if (targets.includes("android")) {
    const properties = path.join(dir, "src-tauri/gen/android/keystore.properties");
    add(
      fs.existsSync(properties) ? "ok" : "fail",
      "Android keystore.properties",
      properties,
      "create it with keyAlias, password and storeFile (docs/wiki/store-builds.md#android-google-play)",
    );
    add(has("java", ["-version"]) ? "ok" : "fail", "Java", "", "install a JDK (17+)");
    const sdk =
      env.ANDROID_HOME || env.ANDROID_SDK_ROOT || path.join(os.homedir(), "Library/Android/sdk");
    add(
      fs.existsSync(sdk) ? "ok" : "fail",
      "Android SDK",
      sdk,
      "install it with Android Studio or set ANDROID_HOME",
    );
    const ndkDir = path.join(sdk, "ndk");
    const ndk =
      env.NDK_HOME ||
      env.ANDROID_NDK_HOME ||
      (fs.existsSync(ndkDir) && fs.readdirSync(ndkDir).length ? ndkDir : null);
    add(
      ndk ? "ok" : "fail",
      "Android NDK",
      ndk ?? "none found",
      "install the NDK in Android Studio (SDK Manager) or set NDK_HOME",
    );
  }

  add(
    ascConfigured() ? "ok" : "warn",
    "App Store Connect API key",
    ascConfigured() ? env.ASC_KEY_ID : "not set",
    "optional: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH give automatic build numbers and --validate",
  );
  return checks;
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(
      `  [${MARK[check.level]}] ${check.label}${check.detail ? `: ${check.detail}` : ""}`,
    );
    if (check.level !== "ok" && check.fix) console.log(`         fix: ${check.fix}`);
  }
}

function doctor(targets) {
  console.log(`release doctor (${targets.join(", ")})`);
  const checks = runChecks(targets);
  printChecks(checks);
  const failed = checks.filter((c) => c.level === "fail").length;
  console.log(failed ? `\n${failed} problem(s) to fix before a release.` : "\nReady to release.");
  return failed === 0;
}

/** Imports the .p12 backups when a certificate is missing and the folder and password are there. */
function ensureCertificates(targets) {
  const signing = resolveSigning(env);
  const missing =
    (targets.includes("ios") && !signing.iosIdentity) ||
    (targets.includes("macos") && !(signing.macApp && signing.macInstaller));
  if (!missing || !env.SIGNING_P12_PASSWORD) return;
  const result = importCertificates(env);
  console.log(`release: certificates missing, importing: ${result.message}`);
  const ios = findProfiles(env, "ios")[0];
  if (ios) installIosProfile(ios);
}

// ---- setup ----
function setup() {
  console.log(`release setup: signing folder ${signingDir(env)}`);
  const result = importCertificates(env);
  console.log(`  ${result.ok ? "ok" : "problem"}: ${result.message}`);
  const ios = findProfiles(env, "ios")[0];
  if (ios) {
    installIosProfile(ios);
    console.log(`  ok: iOS profile "${ios.name}" installed for Xcode`);
  }
  if (!env.KEYCHAIN_PASSWORD) {
    console.log(
      '  note: set KEYCHAIN_PASSWORD in .env to skip the keychain "Always Allow" prompt on the first build',
    );
  }
  console.log("");
  return doctor(PLATFORMS);
}

// ---- builds ----
function build(targets, { buildNumber }) {
  const signing = resolveSigning(env);
  const version = readVersions(root).pkg;
  const out = path.join(root, "release", `${version}-${buildNumber}`);
  fs.mkdirSync(out, { recursive: true });
  console.log(`release: version ${version}, build ${buildNumber} -> ${path.relative(root, out)}`);

  const collect = (from, toDir) => {
    fs.mkdirSync(path.join(out, toDir), { recursive: true });
    const target = path.join(out, toDir, path.basename(from));
    fs.copyFileSync(from, target);
    return target;
  };
  const produced = [];
  const need = (value, what, fix) => value || fail(`${what} not found. ${fix}`);

  const builders = {
    android() {
      run("yarn", ["build", "android", "--production"]);
      const aab = path.join(
        root,
        "src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab",
      );
      if (!fs.existsSync(aab))
        fail("the Android build produced no .aab (is keystore.properties set up?)");
      produced.push(collect(aab, "android"));
    },

    ios() {
      const team = need(signing.team, "Apple team", "run yarn release doctor");
      const identity = need(
        signing.iosIdentity,
        "iOS distribution certificate",
        "run yarn release doctor",
      );
      const profile = need(signing.iosProfile, "iOS App Store profile", "run yarn release doctor");
      if (profile.file) installIosProfile(profile);
      const archive = path.join(root, "src-tauri/gen/apple/build/openmedia_iOS.xcarchive");
      fs.rmSync(archive, { recursive: true, force: true });
      run("yarn", ["tauri", "ios", "build", "--ci", "--target", "aarch64", "--archive-only"], {
        env: { APPLE_DEVELOPMENT_TEAM: team },
      });
      const options = path.join(os.tmpdir(), `openmedia-export-${process.pid}.plist`);
      fs.writeFileSync(
        options,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>teamID</key><string>${team}</string>
<key>signingStyle</key><string>manual</string>
<key>signingCertificate</key><string>${identity}</string>
<key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${profile.name}</string></dict>
<key>destination</key><string>export</string>
<key>uploadSymbols</key><true/>
</dict></plist>
`,
      );
      const exported = path.join(os.tmpdir(), `openmedia-ipa-${process.pid}`);
      fs.rmSync(exported, { recursive: true, force: true });
      run("xcodebuild", [
        "-exportArchive",
        "-archivePath",
        archive,
        "-exportPath",
        exported,
        "-exportOptionsPlist",
        options,
      ]);
      produced.push(collect(path.join(exported, "OpenMedia.ipa"), "ios"));
    },

    macos() {
      const app = need(signing.macApp, "Mac app certificate", "run yarn release doctor");
      const installer = need(
        signing.macInstaller,
        "Mac installer certificate",
        "run yarn release doctor",
      );
      const profile = need(
        signing.macProfile?.file,
        "Mac App Store profile",
        "run yarn release doctor",
      );
      run("yarn", ["tauri", "build", "--bundles", "app"]);
      run("sh", ["scripts/package-mac-app-store.sh"], {
        env: { MAS_APP_IDENTITY: app, MAS_INSTALLER_IDENTITY: installer, MAS_PROFILE: profile },
      });
      produced.push(
        collect(
          path.join(root, "src-tauri/target/release/bundle/macos/OpenMedia-MacAppStore.pkg"),
          "macos",
        ),
      );
    },
  };
  for (const platform of targets) builders[platform]();

  if (flag("--validate")) validate(produced);

  console.log(`\nrelease: done. Upload:`);
  for (const file of produced) {
    const where = file.endsWith(".aab") ? "Play Console" : "Transporter";
    console.log(`  ${file}   (${where})`);
  }
}

function validate(produced) {
  if (!ascConfigured()) fail("--validate needs ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH");
  // altool looks for AuthKey_<id>.p8 in this folder.
  const keys = path.join(os.homedir(), ".appstoreconnect/private_keys");
  const link = path.join(keys, `AuthKey_${env.ASC_KEY_ID}.p8`);
  const planted = !fs.existsSync(link);
  if (planted) {
    fs.mkdirSync(keys, { recursive: true });
    fs.copyFileSync(env.ASC_KEY_PATH.replace(/^~/, os.homedir()), link);
  }
  try {
    for (const file of produced.filter((f) => /\.(ipa|pkg)$/.test(f))) {
      const type = file.endsWith(".ipa") ? "ios" : "macos";
      run("xcrun", [
        "altool",
        "--validate-app",
        "-f",
        file,
        "-t",
        type,
        "--apiKey",
        env.ASC_KEY_ID,
        "--apiIssuer",
        env.ASC_ISSUER_ID,
      ]);
    }
  } finally {
    if (planted) fs.rmSync(link, { force: true });
  }
}

async function chooseBuild() {
  if (explicitBuild !== null) {
    if (!Number.isInteger(explicitBuild) || explicitBuild < 1) fail("--build needs a whole number");
    return explicitBuild;
  }
  if (flag("--no-bump")) return Math.max(...readBuilds(root));
  return nextBuild(root);
}

// ---- bump / ship ----
function bumpFiles(dir, spec, buildNumber) {
  const current = readVersions(dir).pkg;
  const version = nextVersion(current, spec);
  writeVersion(dir, version);
  writeBuild(dir, buildNumber);
  addChangelogEntry(dir, version, buildNumber);
  return version;
}

async function bump() {
  const spec = rest.find((a) => !a.startsWith("--") && !PLATFORMS.includes(a));
  if (!spec) fail("usage: yarn release bump <patch|minor|major|x.y.z>");
  const version = bumpFiles(root, spec, await nextBuild(root));
  console.log(
    `release: version ${version}, build ${Math.max(...readBuilds(root))}. Commit package.json, src-tauri/tauri.conf.json and CHANGELOG.md.`,
  );
}

const git = (gitArgs, cwd = root) => {
  const result = capture("git", gitArgs, cwd);
  if (!result.ok) fail(`git ${gitArgs.join(" ")} failed: ${result.err}`);
  return result.out;
};

/** GitHub registers a PR's checks a few seconds after creation; wait for them, then for the result. */
function waitForChecks(prUrl) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const seen = capture("gh", ["pr", "checks", prUrl]);
    if (!/no checks reported/i.test(`${seen.out}${seen.err}`)) break;
    spawnSync("sleep", ["5"]);
  }
  run("gh", ["pr", "checks", prUrl, "--watch", "--fail-fast"]);
}

async function ship() {
  const spec = rest.find((a) => !a.startsWith("--") && !PLATFORMS.includes(a));
  if (!spec)
    fail("usage: yarn release ship <patch|minor|major|x.y.z> [ios] [android] [macos] [--no-wait]");

  // 1. Fail before touching GitHub if this machine cannot finish the release.
  ensureCertificates(platforms);
  if (!doctor(platforms)) fail("fix the problems above, then run ship again");
  if (!capture("gh", ["auth", "status"]).ok) fail("gh is not logged in (run: gh auth login)");

  // 2. Version PR from a worktree (AGENTS.md: main is never edited directly).
  git(["fetch", "origin"]);
  const version = nextVersion(readVersions(root).pkg, spec);
  const branch = `chore/release-${version}`;
  const tree = path.join(root, ".worktrees", `release-${version}`);
  git(["worktree", "add", "-b", branch, tree, "origin/main"]);
  fs.symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"));
  const buildNumber = await nextBuild(tree);
  bumpFiles(tree, spec, buildNumber);
  const files = Object.values(versionFiles(tree)).map((f) => path.relative(tree, f));
  git(["add", ...files], tree);
  git(["commit", "-m", `chore(release): version ${version}`], tree);
  git(["push", "-u", "origin", branch], tree);
  const url = capture(
    "gh",
    [
      "pr",
      "create",
      "--base",
      "main",
      "--title",
      `chore(release): version ${version}`,
      "--body",
      `Version ${version}, build ${buildNumber}.`,
    ],
    tree,
  );
  if (!url.ok) fail(`gh pr create failed: ${url.err}`);
  const prUrl = url.out.split("\n").pop();
  console.log(`release: ${prUrl}`);

  // 3. Merge: wait for CI unless --no-wait.
  if (flag("--no-wait")) {
    run("gh", ["pr", "merge", prUrl, "--squash", "--admin"]);
  } else {
    waitForChecks(prUrl);
    run("gh", ["pr", "merge", prUrl, "--squash"]);
  }

  // 4. Back to main, clean up, build from the merged state.
  git(["worktree", "remove", "--force", tree]);
  git(["branch", "-D", branch]);
  git(["pull", "--ff-only", "origin", "main"]);
  build(platforms, { buildNumber });
}

// ---- main ----
function help() {
  console.log(`yarn release <command>

  doctor [ios] [android] [macos]   check signing, toolchains and versions; prints a fix per problem
  setup                            import .p12 certificates and install profiles from the signing
                                   folder (${signingDir(env)}), then run doctor
  [build] [ios] [android] [macos]  build the store packages (all three by default)
                                   --no-bump   reuse the build number in tauri.conf.json
                                   --build N   use build number N
                                   --validate  run altool --validate-app on the .ipa and .pkg
  bump <patch|minor|major|x.y.z>   edit version, build number and CHANGELOG.md (no git)
  ship <patch|minor|major|x.y.z>   doctor, version PR, merge, then build from main
                                   --no-wait   merge without waiting for CI (admin merge)

Guide: docs/wiki/store-builds.md`);
}

if (command === "help") help();
else if (command === "doctor") process.exit(doctor(platforms) ? 0 : 1);
else if (command === "setup") process.exit(setup() ? 0 : 1);
else if (command === "bump") await bump();
else if (command === "ship") await ship();
else {
  ensureCertificates(platforms);
  if (!doctor(platforms))
    fail("fix the problems above (or run yarn release setup), then build again");
  const buildNumber = await chooseBuild();
  writeBuild(root, buildNumber);
  build(platforms, { buildNumber });
}
