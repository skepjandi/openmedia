// Usage: yarn release [ios] [android] [macos] [--build N] [--no-bump] [--validate]
//
// Builds the store packages and collects them in release/<version>-<build>/:
//   ios/OpenMedia.ipa                       -> Transporter
//   macos/OpenMedia-MacAppStore.pkg         -> Transporter
//   android/app-universal-release.aab       -> Play Console
//
// The build number is handled for you. Unless --no-bump or --build N is given, it becomes one more
// than the largest of: the numbers in src-tauri/tauri.conf.json (iOS bundleVersion, macOS
// bundleVersion, Android versionCode) and, when App Store Connect credentials are set, the largest
// build number App Store Connect already has. It is written back to tauri.conf.json (commit it).
// Google Play has no query without a service account, so after a "version code already used"
// answer from Play, raise the number with --build N.
//
// Settings come from the environment or ../.env (see docs/wiki/store-builds.md):
//   APPLE_TEAM_ID                         ios, macos
//   IOS_SIGN_IDENTITY, IOS_PROFILE        ios: distribution certificate name, profile name
//   MAS_APP_IDENTITY, MAS_INSTALLER_IDENTITY, MAS_PROFILE, [MAS_KEYCHAIN]   macos (see
//                                         scripts/package-mac-app-store.sh)
//   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH   optional: build-number lookup and --validate
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const confPath = path.join(root, "src-tauri/tauri.conf.json");
const BUNDLE_ID = "surf.openmedia";
const PLATFORMS = ["ios", "android", "macos"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const buildFlag = args.indexOf("--build");
const explicitBuild = buildFlag >= 0 ? Number(args[buildFlag + 1]) : null;
const wanted = args.filter((a) => PLATFORMS.includes(a));
const platforms = wanted.length ? wanted : PLATFORMS;

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

function loadEnv() {
  const file = path.join(root, ".env");
  const values = {};
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  return { ...values, ...process.env };
}
const env = loadEnv();
const need = (name, why) => env[name] || fail(`set ${name} (${why})`);

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
const conf = fs.readFileSync(confPath, "utf8");
const FIELDS = [
  [/("iOS":\s*\{[^}]*?"bundleVersion":\s*")(\d+)(")/, "iOS bundleVersion"],
  [/("macOS":\s*\{[^}]*?"bundleVersion":\s*")(\d+)(")/, "macOS bundleVersion"],
  [/("versionCode":\s*)(\d+)()/, "Android versionCode"],
];
const current = FIELDS.map(([pattern, label]) => {
  const match = conf.match(pattern);
  if (!match) fail(`could not find ${label} in tauri.conf.json`);
  return Number(match[2]);
});

async function chooseBuild() {
  if (explicitBuild !== null) {
    if (!Number.isInteger(explicitBuild) || explicitBuild < 1) fail("--build needs a whole number");
    return explicitBuild;
  }
  const highest = Math.max(...current);
  if (flag("--no-bump")) return highest;
  let known = highest;
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

function writeBuild(build) {
  let text = conf;
  for (const [pattern] of FIELDS) text = text.replace(pattern, `$1${build}$3`);
  fs.writeFileSync(confPath, text);
}

const version = JSON.parse(conf).version;
const build = await chooseBuild();
writeBuild(build);
const out = path.join(root, "release", `${version}-${build}`);
fs.mkdirSync(out, { recursive: true });
console.log(`release: version ${version}, build ${build} -> ${path.relative(root, out)}`);

// ---- builds ----
const collect = (from, toDir) => {
  fs.mkdirSync(path.join(out, toDir), { recursive: true });
  const target = path.join(out, toDir, path.basename(from));
  fs.copyFileSync(from, target);
  return target;
};
const produced = [];

function buildAndroid() {
  run("yarn", ["build", "android", "--production"]);
  const aab = path.join(
    root,
    "src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab",
  );
  if (!fs.existsSync(aab))
    fail("the Android build produced no .aab (is keystore.properties set up?)");
  produced.push(collect(aab, "android"));
}

function buildIos() {
  const team = need("APPLE_TEAM_ID", "the Apple Developer team");
  const identity = need("IOS_SIGN_IDENTITY", "the iOS Distribution certificate name");
  const profile = need("IOS_PROFILE", "the App Store provisioning profile name");
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
<key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${profile}</string></dict>
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
}

function buildMac() {
  need("MAS_APP_IDENTITY", "the Mac App Distribution certificate");
  need("MAS_INSTALLER_IDENTITY", "the Mac Installer Distribution certificate");
  need("MAS_PROFILE", "the Mac App Store provisioning profile file");
  run("yarn", ["tauri", "build", "--bundles", "app"]);
  run("sh", ["scripts/package-mac-app-store.sh"]);
  produced.push(
    collect(
      path.join(root, "src-tauri/target/release/bundle/macos/OpenMedia-MacAppStore.pkg"),
      "macos",
    ),
  );
}

const builders = { android: buildAndroid, ios: buildIos, macos: buildMac };
for (const platform of platforms) builders[platform]();

// ---- validation ----
if (flag("--validate")) {
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

console.log(`\nrelease: done. Upload:`);
for (const file of produced) {
  const where = file.endsWith(".aab") ? "Play Console" : "Transporter";
  console.log(`  ${file}   (${where})`);
}
