// Renders the App Store and Google Play artwork from the simulator captures in
// assets/store/captures/. No dependencies beyond Node, Google Chrome (headless) and ImageMagick.
//
//   node scripts/render-store-assets.mjs            # every set
//   node scripts/render-store-assets.mjs ios/ipad-13 # one set
//
// Set CHROME_BIN to use another Chrome/Chromium binary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const storeDir = path.join(repoRoot, "assets/store");
const chrome =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const fontUrl = pathToFileURL(
  path.join(
    repoRoot,
    "node_modules/@fontsource-variable/schibsted-grotesk/files/schibsted-grotesk-latin-wght-normal.woff2",
  ),
).href;
const iconUrl = pathToFileURL(path.join(repoRoot, "src-tauri/icons/icon.png")).href;

// Copy uses the words the app itself uses. Markers: *accent*.
const slides = [
  { slug: "browse", theme: "ink", eyebrow: "OpenMedia", headline: "The web,|*minus the noise.*" },
  { slug: "fan", theme: "cyan", eyebrow: "One button", headline: "Hold for|*your favorites.*" },
  {
    slug: "recipes",
    theme: "ink",
    eyebrow: "Recipes for 18 sites",
    headline: "Hide *what you|did not ask for.*",
  },
  {
    slug: "browsing",
    theme: "paper",
    eyebrow: "Built-in blocking",
    headline: "Ads and trackers,|*blocked before|they load.*",
  },
  { slug: "usage", theme: "cyan", eyebrow: "Usage", headline: "See where|*your time goes.*" },
  { slug: "limits", theme: "ink", eyebrow: "Daily limits", headline: "Set a limit.|*It sticks.*" },
  {
    slug: "byok",
    theme: "cyan",
    eyebrow: "AI assistant",
    headline: "Your AI key.|*Previewed before|it is sent.*",
  },
  {
    slug: "dark",
    theme: "paper",
    eyebrow: "Appearance",
    headline: "Light, dark,|*or your system.*",
  },
];

const captureExtension = { browse: "jpg", fan: "jpg", dark: "jpg" };
const captureFile = (device, index, slug) =>
  path.join(
    storeDir,
    "captures",
    device,
    `${String(index + 1).padStart(2, "0")}-${slug}.${device === "macbook-pro" ? "png" : (captureExtension[slug] ?? "png")}`,
  );

// width/height: exact store size. deviceWidth and top: device frame width in % of the canvas
// width and its top edge in % of the canvas height (the frame bleeds off the bottom).
const sets = [
  {
    dir: "ios/iphone-6.3",
    width: 1206,
    height: 2622,
    capture: "iphone-17-pro-max",
    kind: "phone",
    deviceWidth: 78,
    top: 21,
  },
  {
    dir: "ios/iphone-6.1",
    width: 1179,
    height: 2556,
    capture: "iphone-17-pro-max",
    kind: "phone",
    deviceWidth: 78,
    top: 21,
  },
  {
    dir: "ios/iphone-6.9",
    width: 1320,
    height: 2868,
    capture: "iphone-17-pro-max",
    kind: "phone",
    deviceWidth: 78,
    top: 21,
  },
  {
    dir: "ios/ipad-13",
    width: 2064,
    height: 2752,
    capture: "ipad-pro-13-m5",
    kind: "tablet",
    deviceWidth: 82,
    top: 26,
  },
  {
    dir: "android/phone",
    width: 1080,
    height: 1920,
    capture: "iphone-17-pro-max",
    kind: "phone",
    deviceWidth: 68,
    top: 26,
  },
  {
    dir: "android/tablet",
    width: 1440,
    height: 2560,
    capture: "ipad-pro-13-m5",
    kind: "tablet",
    deviceWidth: 90,
    top: 30,
  },
  // Mac App Store (APP_DESKTOP): every size is an exact 16:10 render, no scaling.
  ...[
    [2880, 1800],
    [2560, 1600],
    [1440, 900],
    [1280, 800],
  ].map(([width, height]) => ({
    dir: `macos/${width}x${height}`,
    width,
    height,
    capture: "macbook-pro",
    kind: "mac",
  })),
];

const themes = {
  ink: {
    glow: "rgba(6,175,248,.28)",
    background: "radial-gradient(120% 70% at 85% 6%, #0b3f97 0%, #021669 30%, #070b14 78%)",
    text: "#f4f7fc",
    accent: "#06aff8",
    eyebrow: "#06aff8",
    shadow: "0 4u 10u -2u rgba(0,0,0,.6)",
  },
  cyan: {
    glow: "rgba(255,255,255,.34)",
    background: "linear-gradient(170deg, #0589d6 0%, #06aff8 52%, #45c8fb 100%)",
    text: "#04101f",
    accent: "#ffffff",
    eyebrow: "rgba(4,16,31,.7)",
    shadow: "0 4u 10u -2u rgba(2,22,105,.55)",
  },
  paper: {
    glow: "rgba(6,175,248,.22)",
    background: "linear-gradient(180deg, #f7faff 0%, #e2ecf8 100%)",
    text: "#070b14",
    accent: "#0a8fdb",
    eyebrow: "#0a8fdb",
    shadow: "0 4u 10u -2u rgba(2,22,105,.4)",
  },
};

const baseCss = `
@font-face { font-family: "Schibsted Grotesk"; src: url("${fontUrl}") format("woff2"); font-weight: 400 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow: hidden; }
body { font-family: "Schibsted Grotesk", sans-serif; -webkit-font-smoothing: antialiased; }
`;

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function headlineHtml(text) {
  return escapeHtml(text)
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\|/g, "<br>");
}

function frame(kind, widthPx) {
  const bezel = widthPx * (kind === "phone" ? 0.026 : 0.034);
  const screenWidth = widthPx - 2 * bezel;
  const screenRadius = screenWidth * (kind === "phone" ? 0.128 : 0.026);
  return { bezel, screenRadius, outerRadius: screenRadius + bezel };
}

// Mac slides use the native window captures (rounded corners and title bar included) as the
// device. Even slides put the copy on the left and the window beside it; odd slides put the copy
// on top and let the window bleed off the bottom edge.
function macSlideHtml(set, slide, index) {
  const theme = themes[slide.theme];
  const unit = set.width / 100;
  const u = (value) => `${(value * unit).toFixed(2)}px`;
  const shadow = theme.shadow.replace(/(\d+(?:\.\d+)?)u/g, (_, n) => u(Number(n)));
  const image = pathToFileURL(captureFile(set.capture, index, slide.slug)).href;
  const side = index % 2 === 0;
  const windowCss = side
    ? `left: ${u(34)}; width: ${u(64)}; top: 50%; transform: translateY(-50%);`
    : `left: ${u(8)}; width: ${u(84)}; top: ${(set.height * (slide.headline.split("|").length > 2 ? 0.4 : 0.33)).toFixed(1)}px;`;
  const copyCss = side
    ? `left: ${u(4)}; width: ${u(28)}; top: 50%; transform: translateY(-50%);`
    : `left: ${u(5)}; right: ${u(5)}; top: ${u(4.6)};`;
  const headlineSize = side ? 3.5 : 4.4;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}
.canvas { position: relative; width: ${set.width}px; height: ${set.height}px; overflow: hidden;
  background: radial-gradient(60% 50% at 70% 60%, ${theme.glow}, transparent), ${theme.background}; color: ${theme.text}; }
.copy { position: absolute; ${copyCss} }
.eyebrow { font-size: ${u(1.05)}; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 600;
  color: ${theme.eyebrow}; margin-bottom: ${u(1.1)}; }
h1 { font-size: ${u(headlineSize)}; font-weight: 780; line-height: 1.04; letter-spacing: -0.025em; }
h1 em { font-style: normal; color: ${theme.accent}; }
.window { position: absolute; ${windowCss} display: block; filter: drop-shadow(0 ${u(1.6)} ${u(2.4)} rgba(0,0,0,.45)); }
</style></head><body><div class="canvas">
<div class="copy"><div class="eyebrow">${escapeHtml(slide.eyebrow)}</div><h1>${headlineHtml(slide.headline)}</h1></div>
<img class="window" src="${image}" alt="">
</div></body></html>`;
}

function storeSlideHtml(set, slide, index) {
  if (set.kind === "mac") return macSlideHtml(set, slide, index);
  const theme = themes[slide.theme];
  const unit = set.width / 100;
  const u = (value) => `${(value * unit).toFixed(2)}px`;
  const shadow = theme.shadow.replace(/(\d+(?:\.\d+)?)u/g, (_, n) => u(Number(n)));
  const deviceWidthPx = set.deviceWidth * unit;
  const { bezel, screenRadius, outerRadius } = frame(set.kind, deviceWidthPx);
  const headlineSize = set.kind === "phone" ? 9.4 : 7.6;
  const image = pathToFileURL(captureFile(set.capture, index, slide.slug)).href;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}
.canvas { position: relative; width: ${set.width}px; height: ${set.height}px; overflow: hidden;
  background: radial-gradient(70% 38% at 50% 72%, ${theme.glow}, transparent), ${theme.background}; color: ${theme.text}; }
.copy { position: absolute; left: ${u(7)}; right: ${u(7)}; top: ${u(set.kind === "phone" ? 7.4 : 6.6)}; }
.eyebrow { font-size: ${u(2.1)}; letter-spacing: 0.2em; text-transform: uppercase; font-weight: 600;
  color: ${theme.eyebrow}; font-variant-numeric: tabular-nums; margin-bottom: ${u(2.2)}; }
h1 { font-size: ${u(headlineSize)}; font-weight: 780; line-height: 1.03; letter-spacing: -0.025em;
  max-width: ${u(86)}; }
h1 em { font-style: normal; color: ${theme.accent}; }
.device { position: absolute; left: 50%; top: ${set.top}%; width: ${deviceWidthPx}px; margin-left: ${-deviceWidthPx / 2}px;
  padding: ${bezel}px; border-radius: ${outerRadius}px; background: #0b0c10;
  box-shadow: inset 0 0 0 ${u(0.2)} rgba(255,255,255,.2), 0 0 0 ${u(0.12)} rgba(0,0,0,.7), ${shadow}; }
.device img { display: block; width: 100%; border-radius: ${screenRadius}px; }
</style></head><body><div class="canvas">
<div class="copy"><div class="eyebrow">${escapeHtml(slide.eyebrow)}</div><h1>${headlineHtml(slide.headline)}</h1></div>
<div class="device"><img src="${image}" alt=""></div>
</div></body></html>`;
}

function featureGraphicHtml() {
  const phone = (file, left, top) => {
    const width = 224;
    const { bezel, screenRadius, outerRadius } = frame("phone", width);
    return `<div class="device" style="left:${left}px;top:${top}px;width:${width}px;padding:${bezel}px;border-radius:${outerRadius}px"><img style="border-radius:${screenRadius}px" src="${pathToFileURL(path.join(storeDir, "captures/iphone-17-pro-max", file)).href}" alt=""></div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}
.canvas { position: relative; width: 1024px; height: 500px; overflow: hidden; color: #f4f7fc;
  background: radial-gradient(90% 120% at 82% 10%, #0b3f97 0%, #021669 34%, #070b14 82%); }
.icon { position: absolute; left: 64px; top: 78px; width: 112px; height: 112px; border-radius: 26px; box-shadow: 0 14px 36px rgba(0,0,0,.45); }
.name { position: absolute; left: 64px; top: 214px; font-size: 62px; font-weight: 780; letter-spacing: -0.03em; }
.tag { position: absolute; left: 66px; top: 296px; width: 440px; font-size: 32px; font-weight: 520; line-height: 1.18; color: #c8d6ec; letter-spacing: -0.01em; }
.tag em { font-style: normal; color: #06aff8; font-weight: 700; }
.device { position: absolute; background: #0b0c10; box-shadow: inset 0 0 0 1px rgba(255,255,255,.2), 0 0 0 1px rgba(0,0,0,.7), 0 24px 50px -8px rgba(0,0,0,.65); }
.device img { display: block; width: 100%; }
</style></head><body><div class="canvas">
<img class="icon" src="${iconUrl}" alt="">
<div class="name">OpenMedia</div>
<div class="tag">Browse the real web,<br><em>minus the noise.</em></div>
${phone("01-browse.jpg", 520, 76)}
${phone("02-fan.jpg", 764, 150)}
</div></body></html>`;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function renderPage(workDir, name, html, width, height, outFile) {
  const htmlFile = path.join(workDir, `${name}.html`);
  const rawFile = path.join(workDir, `${name}.png`);
  writeFileSync(htmlFile, html);
  run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--allow-file-access-from-files",
    "--virtual-time-budget=5000",
    `--window-size=${width},${height + 200}`,
    `--screenshot=${rawFile}`,
    pathToFileURL(htmlFile).href,
  ]);
  mkdirSync(path.dirname(outFile), { recursive: true });
  // Chrome adds a transparent alpha channel and may pad the viewport; both stores reject alpha.
  run("magick", [
    rawFile,
    "-crop",
    `${width}x${height}+0+0`,
    "+repage",
    "-background",
    "#070b14",
    "-alpha",
    "remove",
    "-alpha",
    "off",
    "-strip",
    "-define",
    "png:compression-level=9",
    `PNG24:${outFile}`,
  ]);
}

const only = process.argv[2];
const workDir = mkdtempSync(path.join(tmpdir(), "openmedia-store-"));
try {
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_BIN.`);
  for (const set of sets) {
    if (only && only !== set.dir) continue;
    slides.forEach((slide, index) => {
      const name = `${String(index + 1).padStart(2, "0")}-${slide.slug}`;
      const outFile = path.join(storeDir, set.dir, `${name}.png`);
      renderPage(
        workDir,
        `${set.dir.replace("/", "-")}-${name}`,
        storeSlideHtml(set, slide, index),
        set.width,
        set.height,
        outFile,
      );
      console.log(`${set.dir}/${name}.png  ${set.width}x${set.height}`);
    });
  }
  if (!only || only === "android/feature-graphic") {
    renderPage(
      workDir,
      "feature-graphic",
      featureGraphicHtml(),
      1024,
      500,
      path.join(storeDir, "android/feature-graphic.png"),
    );
    console.log("android/feature-graphic.png  1024x500");
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
