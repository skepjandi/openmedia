import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLatestJson,
  generateSigningKey,
  injectStyleNonce,
  openBundle,
  packBundle,
  platformKey,
  publicKeyOf,
  releaseAssetName,
} from "./ota-bundle.mjs";

const files = () =>
  new Map([
    ["index.html", Buffer.from("<html><style>a{}</style></html>")],
    ["assets/app.js", Buffer.from("run()")],
  ]);

describe("web bundle", () => {
  const key = generateSigningKey();
  const pack = (privateKey = key.privateKey) =>
    packBundle({ files: files(), runtimeVersion: "1.2.3", revision: 9, privateKey });

  it("opens with the matching public key and carries the files", () => {
    const manifest = openBundle(pack(), key.publicKey);
    expect(manifest).toMatchObject({ format: 1, runtimeVersion: "1.2.3", revision: 9 });
    expect(Buffer.from(manifest.files["assets/app.js"], "base64").toString()).toBe("run()");
  });

  it("does not open for another key or after a changed byte", () => {
    expect(() => openBundle(pack(), generateSigningKey().publicKey)).toThrow();
    const packed = pack();
    packed[packed.length - 1] ^= 1;
    expect(() => openBundle(packed, key.publicKey)).toThrow();
  });

  it("derives the public key the app embeds from the private one", () => {
    expect(publicKeyOf(key.privateKey)).toBe(key.publicKey);
    expect(Buffer.from(key.publicKey, "base64")).toHaveLength(32);
  });

  it("refuses a build with no start page", () => {
    expect(() =>
      packBundle({
        files: new Map([["a.js", Buffer.from("x")]]),
        runtimeVersion: "1",
        revision: 1,
        privateKey: key.privateKey,
      }),
    ).toThrow(/index\.html/);
  });
});

describe("injectStyleNonce", () => {
  it("tags every inline style once and leaves tagged ones alone", () => {
    const html = '<style>a{}</style><style nonce="x">b{}</style><p style="c:d">';
    expect(injectStyleNonce(html)).toBe(
      '<style nonce="__TAURI_STYLE_NONCE__">a{}</style><style nonce="x">b{}</style><p style="c:d">',
    );
  });
});

describe("latest.json", () => {
  const signatures = new Map([
    ["OpenMedia_1.0.0_linux-x86_64.AppImage.sig", "SIGL\n"],
    ["OpenMedia_1.0.0_windows-x86_64.exe.sig", "SIGW\n"],
    ["OpenMedia_1.0.0_darwin-universal.app.tar.gz.sig", "SIGA\n"],
  ]);
  const base = {
    version: "1.0.0",
    notes: "n",
    pubDate: "2026-11-10T00:00:00.000Z",
    downloadBase: "https://example.test/dl",
    signatures,
  };

  it("lists each signed Windows and Linux installer and ignores .deb packages", () => {
    const latest = buildLatestJson({
      ...base,
      assetNames: [
        "OpenMedia_1.0.0_linux-x86_64.AppImage",
        "OpenMedia_1.0.0_linux-x86_64.AppImage.sig",
        "OpenMedia_1.0.0_linux-x86_64.deb",
        "OpenMedia_1.0.0_windows-x86_64.exe",
      ],
    });
    expect(Object.keys(latest.platforms).sort()).toEqual(["linux-x86_64", "windows-x86_64"]);
    expect(latest.platforms["windows-x86_64"]).toEqual({
      signature: "SIGW",
      url: "https://example.test/dl/OpenMedia_1.0.0_windows-x86_64.exe",
    });
  });

  it("never lists a macOS build, even a signed one", () => {
    const latest = buildLatestJson({
      ...base,
      assetNames: ["OpenMedia_1.0.0_darwin-universal.app.tar.gz"],
    });
    expect(latest.platforms).toEqual({});
  });

  it("skips an installer without a signature or built for another version", () => {
    const latest = buildLatestJson({
      ...base,
      assetNames: ["OpenMedia_1.0.0_linux-aarch64.AppImage", "OpenMedia_0.9.0_windows-x86_64.exe"],
    });
    expect(latest.platforms).toEqual({});
  });

  it("names assets the way it parses them", () => {
    expect(releaseAssetName("1.0.0", platformKey("x86_64-unknown-linux-gnu"), "deb")).toBe(
      "OpenMedia_1.0.0_linux-x86_64.deb",
    );
    expect(() => platformKey("aarch64-apple-darwin")).toThrow();
    expect(() => platformKey("riscv64-unknown-none")).toThrow();
  });
});

describe("configuration", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

  it("points the desktop updater at the repository the app and the CLI publish to", () => {
    const repo = read("src-tauri/Cargo.toml").match(/^repository\s*=\s*"([^"]+)"/m)[1];
    const { plugins } = JSON.parse(read("src-tauri/tauri.ota.conf.json"));
    expect(plugins.updater.endpoints).toEqual([`${repo}/releases/latest/download/latest.json`]);
  });

  it("embeds a 32-byte web key and a real updater key", () => {
    expect(Buffer.from(read("src-tauri/ota-public-key.txt").trim(), "base64")).toHaveLength(32);
    const { plugins } = JSON.parse(read("src-tauri/tauri.ota.conf.json"));
    expect(Buffer.from(plugins.updater.pubkey, "base64").toString()).toMatch(/minisign public key/);
  });
});
