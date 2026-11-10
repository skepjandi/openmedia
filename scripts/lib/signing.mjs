// Finds the Apple signing material a release needs, so nobody has to export identity names or
// profile paths by hand. Used by scripts/release.mjs (`yarn release doctor|setup|...`).
//
// Where things come from, in priority order:
//   1. An explicit setting in the environment or .env (IOS_SIGN_IDENTITY, MAS_PROFILE, ...).
//   2. The login keychain (certificates) and the signing folder (profiles and .p12 backups).
//
// The signing folder is SIGNING_DIR, default ~/Documents/openmedia-signing. It is outside the repo
// on purpose: nothing in it is ever committed. See docs/wiki/store-builds.md#signing-material.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BUNDLE_ID = "surf.openmedia";

const home = os.homedir();
export const LOGIN_KEYCHAIN = path.join(home, "Library/Keychains/login.keychain-db");
const IOS_PROFILE_INSTALL_DIR = path.join(home, "Library/MobileDevice/Provisioning Profiles");
const IOS_PROFILE_DIRS = [
  IOS_PROFILE_INSTALL_DIR,
  path.join(home, "Library/Developer/Xcode/UserData/Provisioning Profiles"),
];

const expand = (p) => p.replace(/^~(?=$|\/)/, home);

export const signingDir = (env) =>
  expand(env.SIGNING_DIR || path.join(home, "Documents/openmedia-signing"));

// ---- certificates ----

/** Names of every valid signing identity, including installer certificates. */
export function listIdentities() {
  const names = new Set();
  for (const extra of [[], ["-p", "basic"]]) {
    const out = spawnSync("security", ["find-identity", "-v", ...extra], { encoding: "utf8" });
    for (const match of (out.stdout ?? "").matchAll(/^\s*\d+\)\s+[0-9A-F]{40}\s+"([^"]+)"/gm)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

const ROLES = {
  ios: /^(iPhone|Apple) Distribution:/,
  macApp: /^(3rd Party Mac Developer Application|Mac App Distribution|Apple Distribution):/,
  macInstaller: /^(3rd Party Mac Developer Installer|Mac Installer Distribution):/,
};

const teamOf = (identity) => identity?.match(/\(([A-Z0-9]{10})\)\s*$/)?.[1] ?? null;

function pick(names, role, team) {
  const matches = names.filter((name) => ROLES[role].test(name));
  return matches.find((name) => team && teamOf(name) === team) ?? matches[0] ?? null;
}

// ---- provisioning profiles ----

/** One plist value from a decoded profile, or null when the key is absent. */
function extract(plist, keyPath) {
  const result = spawnSync("plutil", ["-extract", keyPath, "raw", "-o", "-", "-"], {
    input: plist,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readProfile(file) {
  const cms = spawnSync("security", ["cms", "-D", "-i", file], { encoding: "buffer" });
  if (cms.status !== 0) return null;
  const plist = cms.stdout;
  const appId =
    extract(plist, "Entitlements.application-identifier") ??
    extract(plist, "Entitlements.com\\.apple\\.application-identifier");
  const expires = extract(plist, "ExpirationDate");
  return {
    file,
    name: extract(plist, "Name"),
    uuid: extract(plist, "UUID"),
    appId,
    expires: expires ? new Date(expires) : null,
    teamId: extract(plist, "TeamIdentifier.0"),
    // A store profile lists no devices and does not allow debugging.
    forDevices: extract(plist, "ProvisionedDevices") !== null,
    debuggable: extract(plist, "Entitlements.get-task-allow") === "true",
  };
}

/**
 * Valid App Store profiles for the app, newest expiry first. `kind` is "ios" or "macos".
 * Candidates: the signing folder, plus Xcode's profile folders for iOS.
 */
export function findProfiles(env, kind) {
  const extension = kind === "ios" ? ".mobileprovision" : ".provisionprofile";
  const dirs = kind === "ios" ? [signingDir(env), ...IOS_PROFILE_DIRS] : [signingDir(env)];
  const seen = new Set();
  const profiles = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(extension)) continue;
      const profile = readProfile(path.join(dir, entry));
      if (!profile || seen.has(profile.uuid)) continue;
      seen.add(profile.uuid);
      const usable =
        profile.appId?.endsWith(`.${BUNDLE_ID}`) &&
        profile.expires > new Date() &&
        !profile.forDevices &&
        !profile.debuggable;
      if (usable) profiles.push(profile);
    }
  }
  return profiles.sort((a, b) => b.expires - a.expires);
}

/** Xcode finds an iOS profile by name only when it sits in its profile folder. */
export function installIosProfile(profile) {
  if (IOS_PROFILE_DIRS.some((dir) => profile.file.startsWith(dir))) return;
  fs.mkdirSync(IOS_PROFILE_INSTALL_DIR, { recursive: true });
  fs.copyFileSync(
    profile.file,
    path.join(IOS_PROFILE_INSTALL_DIR, `${profile.uuid}.mobileprovision`),
  );
}

// ---- resolve everything a release needs ----

/**
 * The signing values for a release, each from the environment when set and otherwise discovered.
 * `source` says where each came from; a missing value is null.
 */
export function resolveSigning(env) {
  const names = listIdentities();
  const iosIdentity = env.IOS_SIGN_IDENTITY || pick(names, "ios", env.APPLE_TEAM_ID);
  const macApp = env.MAS_APP_IDENTITY || pick(names, "macApp", env.APPLE_TEAM_ID);
  const macInstaller = env.MAS_INSTALLER_IDENTITY || pick(names, "macInstaller", env.APPLE_TEAM_ID);
  const team = env.APPLE_TEAM_ID || teamOf(iosIdentity) || teamOf(macApp);
  const iosProfile = env.IOS_PROFILE
    ? { name: env.IOS_PROFILE, file: null, expires: null }
    : (findProfiles(env, "ios")[0] ?? null);
  const macProfile = env.MAS_PROFILE
    ? { name: path.basename(env.MAS_PROFILE), file: expand(env.MAS_PROFILE), expires: null }
    : (findProfiles(env, "macos")[0] ?? null);
  return { team, iosIdentity, iosProfile, macApp, macInstaller, macProfile };
}

// ---- importing certificate backups ----

/**
 * Imports every .p12 in the signing folder into the login keychain, then (when KEYCHAIN_PASSWORD is
 * set) allows codesign and productbuild to use the keys without a prompt. Safe to repeat.
 */
export function importCertificates(env) {
  const dir = signingDir(env);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".p12")) : [];
  if (files.length === 0) {
    return { ok: false, message: `no .p12 files in ${dir}` };
  }
  if (!env.SIGNING_P12_PASSWORD) {
    return {
      ok: false,
      message: "set SIGNING_P12_PASSWORD (the password the .p12 files were exported with) in .env",
    };
  }
  const failures = [];
  for (const file of files) {
    const result = spawnSync(
      "security",
      [
        "import",
        path.join(dir, file),
        "-k",
        LOGIN_KEYCHAIN,
        "-P",
        env.SIGNING_P12_PASSWORD,
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/productsign",
        "-T",
        "/usr/bin/productbuild",
      ],
      { encoding: "utf8" },
    );
    const text = `${result.stdout}${result.stderr}`;
    if (result.status !== 0 && !/already exists/i.test(text))
      failures.push(`${file}: ${text.trim()}`);
  }
  if (failures.length) return { ok: false, message: failures.join("\n") };
  if (env.KEYCHAIN_PASSWORD) {
    spawnSync(
      "security",
      [
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        env.KEYCHAIN_PASSWORD,
        LOGIN_KEYCHAIN,
      ],
      { encoding: "utf8" },
    );
  }
  return { ok: true, message: `imported ${files.length} file(s) from ${dir}` };
}
