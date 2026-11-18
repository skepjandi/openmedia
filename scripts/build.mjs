// Usage: yarn build                          -> web bundle
//        yarn build ios                      -> iOS app (Xcode signing)
//        yarn build ios --production         -> signed App Store Connect iOS build
//        yarn build android                  -> debug-signed arm64 APK, installable on a device
//        yarn build android --production     -> release AAB for Google Play (needs keystore.properties)
//        yarn build macos                    -> OpenMedia.app
//        yarn build macos --production       -> every macOS bundle (.app and .dmg)
//        yarn build windows                  -> NSIS installer (run on Windows)
//        yarn build windows --production     -> same, with the updater feature and signed updater artifact
//        yarn build linux                    -> AppImage and .deb (run on Linux)
//        yarn build linux --production       -> same, with the updater feature and signed updater artifact
//
// Windows and Linux are the free desktop platforms and the only ones published to GitHub Releases
// (`yarn release github`); iOS, Android and macOS builds are for the stores. Tauri cannot cross-build
// the Windows and Linux bundles from another OS; pass `--target <triple>` to try anyway.
import { spawnSync } from "node:child_process";
import path from "node:path";

const USAGE = `Usage: yarn build [ios|android|macos|windows|linux] [--production] [--target <triple>]`;

const [target, ...flags] = process.argv.slice(2);
const production = flags.includes("--production");
const targetAt = flags.indexOf("--target");
const triple = targetAt >= 0 ? flags[targetAt + 1] : undefined;

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const tauri = (...args) => run("yarn", ["tauri", ...args]);

const HOSTS = { windows: "win32", linux: "linux" };

function desktop(system, bundles) {
  if (!triple && process.platform !== HOSTS[system]) {
    console.error(
      `yarn build ${system} must run on ${system === "windows" ? "Windows" : "Linux"} (this is ${process.platform}); Tauri cannot cross-build it. Use that OS, CI (\`yarn release github\`), or pass --target <triple> to force it.`,
    );
    process.exit(1);
  }
  const updater = production
    ? [
        "--config",
        path.join("src-tauri", "tauri.ota.conf.json"),
        "--features",
        "self-update",
        "--bundles",
        bundles,
      ]
    : ["--bundles", bundles.split(",")[0]];
  tauri("build", ...updater, ...(triple ? ["--target", triple] : []));
}

const builds = {
  ios: () => tauri("ios", "build", ...(production ? ["--export-method", "app-store-connect"] : [])),
  android: () =>
    tauri(
      "android",
      "build",
      ...(production ? ["--aab", "--ci"] : ["--apk", "--debug", "--target", "aarch64", "--ci"]),
    ),
  macos: () => tauri("build", ...(production ? [] : ["--bundles", "app"])),
  windows: () => desktop("windows", "nsis"),
  linux: () => desktop("linux", "appimage,deb"),
};

if (!target) run("yarn", ["build:web"]);
else if (target in builds) builds[target]();
else {
  console.error(`Unknown target "${target}".\n${USAGE}`);
  process.exit(1);
}
