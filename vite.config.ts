import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import process from "node:process";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

const LOGO_PLACEHOLDER = "<!--logo-mark-->";
const STYLESHEET_LINK = /<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g;

/**
 * Puts what the first paint needs into the HTML itself, so the splash is on screen from the very
 * first frame instead of after two more requests (the logo, the stylesheet). The logo comes from
 * the one source file the app also imports; the built stylesheet replaces its `<link>`.
 */
function inlineFirstPaint(): Plugin {
  return {
    name: "openmedia-inline-first-paint",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const logo = readFileSync(new URL("./src/assets/logo-mark.svg", import.meta.url), "utf8");
        const withLogo = html.replace(LOGO_PLACEHOLDER, logo.trim());
        const bundle = context.bundle;
        if (!bundle) return withLogo;
        return withLogo.replace(STYLESHEET_LINK, (link, href: string) => {
          const name = href.replace(/^\//, "");
          const asset = bundle[name];
          if (asset?.type !== "asset") return link;
          Reflect.deleteProperty(bundle, name);
          return `<style>${String(asset.source)}</style>`;
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineFirstPaint()],
  clearScreen: false,
  build: {
    // iOS 17 is the minimum (see platform-support.md), so nothing needs lowering below Safari 17.
    target: "safari17",
    // Safari has had native modulepreload since 17.
    modulePreload: { polyfill: false },
    // The bundled site icons are 270-odd small PNGs. Inlined they put hundreds of KB of base64
    // into the entry chunk that every launch parses; as files they cost nothing until drawn.
    assetsInlineLimit: (file) => (file.includes("/site-icons/") ? false : undefined),
    reportCompressedSize: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"] },
});
