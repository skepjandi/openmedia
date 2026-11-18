// The pure half of `yarn ota`: the web bundle format the app verifies (src-tauri/src/ota/bundle.rs
// is its reader), release asset names, and the desktop updater's latest.json. No I/O beyond
// reading the build folder, so all of it is testable.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const FORMAT = 1;
const SIGNING_CONTEXT = Buffer.from("openmedia-ota-v1\n");
// Tauri swaps this token for a fresh nonce on every page load. The embedded index.html has it on
// its inline <style>; without it the CSP would block the style of a served-from-disk page.
const STYLE_NONCE_TOKEN = "__TAURI_STYLE_NONCE__";
const PRODUCT = "OpenMedia";

export const pointerName = (runtimeVersion) => `latest-${runtimeVersion}.json`;
export const bundleName = (runtimeVersion, revision) => `bundle-${runtimeVersion}-${revision}.ota`;

// ---- keys ----

/** An Ed25519 key pair: the private key as base64 PKCS#8, the public one as base64 raw bytes. */
export function generateSigningKey() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  return { privateKey: pkcs8, publicKey: publicKeyOf(pkcs8) };
}

function privateKeyObject(pkcs8Base64) {
  return crypto.createPrivateKey({
    key: Buffer.from(pkcs8Base64.trim(), "base64"),
    format: "der",
    type: "pkcs8",
  });
}

export function publicKeyOf(pkcs8Base64) {
  const spki = crypto
    .createPublicKey(privateKeyObject(pkcs8Base64))
    .export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("base64");
}

function publicKeyObject(rawBase64) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(rawBase64.trim(), "base64")]),
    format: "der",
    type: "spki",
  });
}

// ---- web bundle ----

/** Every file under `root`, keyed by its forward-slash path relative to it. */
export function collectFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile())
        files.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full));
    }
  };
  walk(root);
  return files;
}

export function injectStyleNonce(html) {
  return html.replace(/<style(?![^>]*\snonce=)/g, `<style nonce="${STYLE_NONCE_TOKEN}"`);
}

/**
 * `signature (64 bytes) ‖ gzip(manifest JSON)`, signed over the context and the gzip bytes so the
 * app checks the signature before it decompresses or parses anything.
 */
export function packBundle({ files, runtimeVersion, revision, privateKey }) {
  if (!files.has("index.html")) throw new Error("the build has no index.html");
  const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const manifest = {
    format: FORMAT,
    runtimeVersion,
    revision,
    files: Object.fromEntries(
      entries.map(([name, bytes]) => {
        const body =
          name === "index.html" ? Buffer.from(injectStyleNonce(bytes.toString("utf8"))) : bytes;
        return [name, body.toString("base64")];
      }),
    ),
  };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 9 });
  const signature = crypto.sign(
    null,
    Buffer.concat([SIGNING_CONTEXT, compressed]),
    privateKeyObject(privateKey),
  );
  return Buffer.concat([signature, compressed]);
}

/** Opens a packed bundle the way the app does; throws unless `publicKey` signed it. */
export function openBundle(packed, publicKey) {
  const signature = packed.subarray(0, 64);
  const compressed = packed.subarray(64);
  const message = Buffer.concat([SIGNING_CONTEXT, compressed]);
  if (!crypto.verify(null, message, publicKeyObject(publicKey), signature))
    throw new Error("the bundle is not signed by the key the app trusts");
  return JSON.parse(zlib.gunzipSync(compressed).toString("utf8"));
}

/** The small file the app reads first to learn whether a newer bundle exists. */
export const pointerFor = ({ runtimeVersion, revision, size }) => ({
  runtimeVersion,
  revision,
  size,
});

// ---- desktop updater ----

// Windows and Linux only: iOS, Android and macOS builds ship through their stores and are never
// published as releases (AGENTS.md, "Platforms and Pricing").
const TRIPLES = {
  "x86_64-pc-windows-msvc": "windows-x86_64",
  "aarch64-pc-windows-msvc": "windows-aarch64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "aarch64-unknown-linux-gnu": "linux-aarch64",
};

/** The updater's platform key for a Rust target triple. */
export function platformKey(triple) {
  const key = TRIPLES[triple];
  if (!key) throw new Error(`no desktop updater platform for target ${triple}`);
  return key;
}

/** The file the updater downloads for each OS, as `tauri build` names it. */
export const UPDATER_ARTIFACT = {
  windows: /-setup\.exe$/,
  linux: /\.AppImage$/,
};

/** The extra installer published beside the Linux updater artifact (not part of `latest.json`). */
export const LINUX_PACKAGE = /\.deb$/;

export const releaseAssetName = (version, key, extension) =>
  `${PRODUCT}_${version}_${key}.${extension}`;

const ASSET = new RegExp(
  `^${PRODUCT}_(.+?)_((?:windows|linux)-(?:aarch64|x86_64))\\.(exe|AppImage)$`,
);

/**
 * Tauri's `latest.json`: one entry per platform that has both an installer and its signature among
 * the release's assets (`.deb` packages and anything else are ignored). `signatures` maps an asset name to the text of its `.sig` file.
 */
export function buildLatestJson({ version, notes, pubDate, downloadBase, assetNames, signatures }) {
  const platforms = {};
  for (const name of assetNames) {
    const match = name.match(ASSET);
    const signature = signatures.get(`${name}.sig`);
    if (!match || match[1] !== version || signature === undefined) continue;
    platforms[match[2]] = { signature: signature.trim(), url: `${downloadBase}/${name}` };
  }
  return { version, notes, pub_date: pubDate, platforms };
}
