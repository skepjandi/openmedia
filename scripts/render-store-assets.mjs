// Renders the App Store and Google Play artwork from the simulator captures in
// assets/store/captures/. No dependencies beyond Node, Google Chrome (headless) and ImageMagick.
//
// Every set is one panorama: a single wide scene (background, ribbon, particles, devices and
// zoom cards) that is sliced into one image per store slot. Each slice still stands alone: the
// copy and the device sit inside it, and only the backdrop and the zoom cards cross a seam.
//
//   node scripts/render-store-assets.mjs            # every set
//   node scripts/render-store-assets.mjs ios/ipad-13 # one set
//   node scripts/render-store-assets.mjs --panorama  # also write each set's full strip to /tmp
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

const BRAND = { cyan: "#06aff8", sky: "#8fe3ff", violet: "#6d5cff", ink: "#070b14" };

// Copy uses the words the app itself uses. Markers: *accent*, | = line break.
const slides = [
  { slug: "browse", eyebrow: "OpenMedia", headline: "The web,|*minus the noise.*", hero: true },
  { slug: "fan", eyebrow: "One button", headline: "Hold for|*your favorites.*" },
  {
    slug: "recipes",
    eyebrow: "Recipes for 18 sites",
    headline: "Hide *what you|did not ask for.*",
  },
  {
    slug: "browsing",
    eyebrow: "Built-in blocking",
    headline: "Ads and trackers,|*blocked before|they load.*",
  },
  { slug: "usage", eyebrow: "Usage", headline: "See where|*your time goes.*" },
  { slug: "limits", eyebrow: "Daily limits", headline: "Set a limit.|*It sticks.*" },
  {
    slug: "byok",
    eyebrow: "AI assistant",
    headline: "Your AI key.|*Previewed before|it is sent.*",
  },
  { slug: "dark", eyebrow: "Appearance", headline: "Light, dark,|*or your system.*" },
];
const COUNT = slides.length;

const captureExtension = { browse: "jpg", fan: "jpg", dark: "jpg" };
const captureFile = (device, index, slug) =>
  path.join(
    storeDir,
    "captures",
    device,
    `${String(index + 1).padStart(2, "0")}-${slug}.${device === "macbook-pro" ? "png" : (captureExtension[slug] ?? "png")}`,
  );
const captureUrl = (device, index) =>
  pathToFileURL(captureFile(device, index, slides[index].slug)).href;

// Native capture sizes, per capture family. Zoom-card crops are fractions of these.
const families = {
  phone: { capture: "iphone-17-pro-max", width: 1320, height: 2868 },
  tablet: { capture: "ipad-pro-13-m5", width: 2064, height: 2752 },
  mac: { capture: "macbook-pro", width: 2880, height: 1800 },
};

// Zoom card: a real crop of the capture, enlarged and floated over the device. It belongs to a
// slide and sticks out of one of its edges into the neighbour, which is what ties the strip
// together. rect = [x, y, w, h] as fractions of the capture; w = card width in % of the canvas
// width; poke = share of the card that crosses the seam. It is centred on the region it
// magnifies and only repeats something its own slide already shows. A family without an entry
// (the Mac window is already large) gets no card.
const zoomCards = [
  {
    slide: 1,
    side: "right",
    phone: { rect: [0.4, 0.345, 0.6, 0.34], w: 70, poke: 0.2 },
    tablet: { rect: [0.64, 0.44, 0.36, 0.3], w: 46, poke: 0.2 },
  },
];

// width/height: exact store size. deviceWidth: device width in % of the canvas width; top: its top
// edge in % of the canvas height (the device bleeds off the bottom). frame: how the capture is
// presented. Android sets are frameless: Google advises against device art in listings.
const sets = [
  {
    dir: "ios/iphone-6.3",
    width: 1206,
    height: 2622,
    family: "phone",
    frame: "iphone",
    deviceWidth: 78,
    top: 22.5,
  },
  {
    dir: "ios/iphone-6.1",
    width: 1179,
    height: 2556,
    family: "phone",
    frame: "iphone",
    deviceWidth: 78,
    top: 22.5,
  },
  {
    dir: "ios/iphone-6.9",
    width: 1320,
    height: 2868,
    family: "phone",
    frame: "iphone",
    deviceWidth: 78,
    top: 22.5,
  },
  {
    dir: "ios/ipad-13",
    width: 2064,
    height: 2752,
    family: "tablet",
    frame: "ipad",
    deviceWidth: 84,
    top: 27,
  },
  {
    dir: "android/phone",
    width: 1080,
    height: 1920,
    family: "phone",
    frame: "bare",
    deviceWidth: 66,
    top: 27,
  },
  {
    dir: "android/tablet",
    width: 1440,
    height: 2560,
    family: "tablet",
    frame: "bare",
    deviceWidth: 94,
    top: 31,
  },
  // Mac App Store (APP_DESKTOP). Rendered once at 2880x1800; the other sizes are exact 16:10
  // downscales of it.
  {
    dir: "macos/2880x1800",
    width: 2880,
    height: 1800,
    family: "mac",
    frame: "window",
    deviceWidth: 86,
    top: 30,
    derive: [
      [2560, 1600],
      [1440, 900],
      [1280, 800],
    ],
  },
];

const baseCss = `
@font-face { font-family: "Schibsted Grotesk"; src: url("${fontUrl}") format("woff2"); font-weight: 400 900; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { overflow: hidden; background: ${BRAND.ink}; }
body { font-family: "Schibsted Grotesk", sans-serif; -webkit-font-smoothing: antialiased; }
`;

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function headlineHtml(text, flow) {
  const html = escapeHtml(text).replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return flow ? html.replace(/\|/g, " ") : html.replace(/\|/g, "<br>");
}

// Deterministic PRNG so the strip is identical on every run.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Backdrop: ink at both ends, royal blue in the middle, with aurora glows on the seams. The text
// zone stays dark so the white headline and the cyan accent keep their contrast.
function backdropCss(set, total) {
  const { width: W, height: H } = set;
  const glows = [];
  for (let seam = 1; seam < COUNT; seam++) {
    const high = seam % 2 === 1;
    const color = seam % 3 === 0 ? BRAND.violet : BRAND.cyan;
    const alpha = seam % 3 === 0 ? 0.5 : 0.42;
    const x = seam * W;
    const y = (high ? 0.34 : 0.82) * H;
    glows.push(
      `radial-gradient(${(0.8 * W).toFixed(0)}px ${(0.7 * W).toFixed(0)}px at ${x}px ${y.toFixed(0)}px, ${hexA(color, alpha)}, transparent)`,
    );
  }
  glows.push(
    `radial-gradient(${(0.7 * W).toFixed(0)}px ${(0.55 * W).toFixed(0)}px at ${0.8 * W}px ${0.9 * H}px, ${hexA(BRAND.cyan, 0.22)}, transparent)`,
  );
  glows.push(
    `radial-gradient(${(0.7 * W).toFixed(0)}px ${(0.55 * W).toFixed(0)}px at ${total - 0.6 * W}px ${0.12 * H}px, ${hexA(BRAND.violet, 0.3)}, transparent)`,
  );
  return [
    `linear-gradient(180deg, rgba(3,6,14,.55) 0%, rgba(3,6,14,0) 30%, rgba(3,6,14,0) 70%, rgba(3,6,14,.35) 100%)`,
    ...glows,
    `linear-gradient(90deg, #070b14 0%, #031a63 24%, #093a94 46%, #08307f 62%, #04206b 82%, #070b14 100%)`,
  ].join(", ");
}

function hexA(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Ribbon and particles, drawn only for the slices the current image can see. The ribbon is a
// bundle of thin lines that twists as it crosses the strip. The particles are trackers: thick on
// the left, gone by the right, which is the whole story of the app.
function sceneSvg(set, slide, total, ribbonY, density) {
  const { width: W, height: H } = set;
  const U = W / 100;
  const x0 = (slide - 1) * W;
  const span = 3 * W;
  const rand = rng(7 + slide * 31);
  const lines = 13;
  const step = W / 36;
  const paths = [];
  for (let k = 0; k < lines; k++) {
    const d = (k - (lines - 1) / 2) / ((lines - 1) / 2);
    let path = "";
    for (let x = x0; x <= x0 + span + step; x += step) {
      const centre = H * ribbonY + H * 0.07 * Math.sin((x / (1.7 * W)) * Math.PI * 2 + 0.6);
      const twist = H * 0.05 * d * Math.sin((x / (1.15 * W)) * Math.PI * 2 + 1.3 + k * 0.04);
      path += `${path ? "L" : "M"}${x.toFixed(1)} ${(centre + twist).toFixed(1)}`;
    }
    const strong = k === 2 || k === 6;
    paths.push(
      `<path d="${path}" fill="none" stroke="url(#ribbon)" stroke-width="${((strong ? 0.34 : 0.17) * U).toFixed(2)}" stroke-opacity="${strong ? 0.9 : 0.3 + 0.35 * (1 - Math.abs(d))}"/>`,
    );
  }
  // Ripples centred on every seam, so a ring is always cut by the slice edge and picked up again
  // by the next slice.
  const rings = [];
  for (let seam = 0; seam <= COUNT; seam++) {
    const cx = seam * W;
    if (cx < x0 - 1.5 * W || cx > x0 + span + 1.5 * W) continue;
    const cy = (seam % 2 === 1 ? 0.36 : 0.8) * H;
    [0.45, 0.72, 1.02, 1.36].forEach((radius, n) => {
      rings.push(
        `<circle cx="${cx}" cy="${cy.toFixed(0)}" r="${(radius * W).toFixed(0)}" fill="none" stroke="#bfe9ff" stroke-opacity="${(0.17 - n * 0.03).toFixed(2)}" stroke-width="${(0.14 * U).toFixed(2)}"/>`,
      );
    });
  }
  const particles = [];
  const candidates = 2600;
  for (let n = 0; n < candidates; n++) {
    const x = rand() * total;
    const y = rand() * H;
    const size = (0.12 + rand() * rand() * 0.55) * U;
    const kind = rand();
    const alpha = 0.12 + rand() * 0.4;
    const keep = rand() < density(x / total);
    if (!keep || x < x0 || x > x0 + span) continue;
    const fill = kind < 0.55 ? "#ffffff" : kind < 0.85 ? BRAND.sky : BRAND.violet;
    particles.push(
      kind > 0.8
        ? `<rect x="${(x - size).toFixed(1)}" y="${(y - size).toFixed(1)}" width="${(size * 2).toFixed(1)}" height="${(size * 2).toFixed(1)}" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})" fill="${fill}" fill-opacity="${alpha.toFixed(2)}"/>`
        : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(2)}" fill="${fill}" fill-opacity="${alpha.toFixed(2)}"/>`,
    );
  }
  return `<svg style="position:absolute;left:${x0}px;top:0" width="${span}" height="${H}" viewBox="${x0} 0 ${span} ${H}">
<defs>
<linearGradient id="ribbon" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${(2.4 * W).toFixed(0)}" y2="0" spreadMethod="repeat">
<stop offset="0" stop-color="${BRAND.cyan}"/><stop offset="0.5" stop-color="#c9f0ff"/><stop offset="1" stop-color="${BRAND.violet}"/>
</linearGradient>
<filter id="soft" x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation="${(0.9 * U).toFixed(2)}"/></filter>
</defs>
<g>${rings.join("")}</g>
<g filter="url(#soft)" opacity="0.9">${paths.join("")}</g>
<g>${paths.join("")}</g>
<g>${particles.join("")}</g>
</svg>`;
}

// ---- devices ---------------------------------------------------------------------------------

function phoneFrame(set, src, left, top) {
  const U = set.width / 100;
  const dw = set.deviceWidth * U;
  const rim = dw * 0.0055;
  const bezel = dw * 0.024;
  const screenW = dw - 2 * (rim + bezel);
  const screenR = screenW * 0.128;
  const innerR = screenR + bezel;
  const outerR = innerR + rim;
  const key = (topPct, heightPct, side, thick) =>
    `<i style="position:absolute;${side}:${(-dw * 0.0085).toFixed(1)}px;top:${topPct}%;height:${heightPct}%;width:${(dw * 0.0085).toFixed(1)}px;border-radius:${(dw * 0.004).toFixed(1)}px;background:linear-gradient(${side === "left" ? 270 : 90}deg,#1c1e25,#4b4f5b);${thick ? "" : ""}"></i>`;
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${dw}px;padding:${rim}px;border-radius:${outerR}px;
background:linear-gradient(150deg,#7a808d 0%,#262932 16%,#0c0d12 46%,#2a2d36 80%,#8a909c 100%);
box-shadow:0 0 0 ${(0.1 * U).toFixed(2)}px rgba(0,0,0,.6), 0 ${(3.4 * U).toFixed(1)}px ${(7 * U).toFixed(1)}px -${U}px rgba(0,0,0,.65), 0 0 ${(9 * U).toFixed(1)}px rgba(6,175,248,.16)">
${key(10, 3.2, "left")}${key(16, 6, "left")}${key(23.5, 6, "left")}${key(19, 11, "right")}
<div style="padding:${bezel}px;border-radius:${innerR}px;background:#04050a">
<div style="position:relative;border-radius:${screenR}px;overflow:hidden;background:#000">
<img src="${src}" style="display:block;width:100%" alt="">
<div style="position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.13) 0%,rgba(255,255,255,0) 30%)"></div>
</div></div></div>`;
}

function tabletFrame(set, src, left, top) {
  const U = set.width / 100;
  const dw = set.deviceWidth * U;
  const rim = dw * 0.004;
  const bezel = dw * 0.03;
  const screenW = dw - 2 * (rim + bezel);
  const screenR = screenW * 0.03;
  const innerR = screenR + bezel;
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${dw}px;padding:${rim}px;border-radius:${innerR + rim}px;
background:linear-gradient(150deg,#7a808d 0%,#262932 16%,#0c0d12 46%,#2a2d36 80%,#8a909c 100%);
box-shadow:0 0 0 ${(0.1 * U).toFixed(2)}px rgba(0,0,0,.6), 0 ${(3 * U).toFixed(1)}px ${(7 * U).toFixed(1)}px -${U}px rgba(0,0,0,.65), 0 0 ${(9 * U).toFixed(1)}px rgba(6,175,248,.16)">
<div style="padding:${bezel}px;border-radius:${innerR}px;background:#04050a">
<div style="position:relative;border-radius:${screenR}px;overflow:hidden;background:#000">
<img src="${src}" style="display:block;width:100%" alt="">
<div style="position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.12) 0%,rgba(255,255,255,0) 28%)"></div>
</div></div></div>`;
}

function bareFrame(set, src, left, top) {
  const U = set.width / 100;
  const dw = set.deviceWidth * U;
  const radius = set.family === "phone" ? dw * 0.075 : dw * 0.03;
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${dw}px;border-radius:${radius}px;overflow:hidden;
box-shadow:0 0 0 ${(0.16 * U).toFixed(2)}px rgba(255,255,255,.28), 0 ${(3.4 * U).toFixed(1)}px ${(7 * U).toFixed(1)}px -${U}px rgba(0,0,0,.7), 0 0 ${(9 * U).toFixed(1)}px rgba(6,175,248,.2)">
<img src="${src}" style="display:block;width:100%" alt=""></div>`;
}

// The window captures already carry their rounded corners and title bar.
function windowFrame(set, src, left, top) {
  const U = set.width / 100;
  const dw = set.deviceWidth * U;
  return `<img src="${src}" alt="" style="position:absolute;left:${left}px;top:${top}px;width:${dw}px;display:block;
filter:drop-shadow(0 ${(1.8 * U).toFixed(1)}px ${(2.6 * U).toFixed(1)}px rgba(0,0,0,.5)) drop-shadow(0 0 ${(4 * U).toFixed(1)}px rgba(6,175,248,.18))">`;
}

const frames = { iphone: phoneFrame, ipad: tabletFrame, bare: bareFrame, window: windowFrame };

function zoomCardHtml(set, card) {
  const spec = card[set.family];
  if (!spec) return "";
  const family = families[set.family];
  const { width: W, height: H } = set;
  const U = W / 100;
  const [cx, cy, cw, ch] = spec.rect;
  const width = spec.w * U;
  const scale = width / (cw * family.width);
  const height = ch * family.height * scale;
  const left =
    card.side === "right"
      ? (card.slide + 1) * W - (1 - spec.poke) * width
      : card.slide * W - spec.poke * width;
  // The card is centred vertically on the region it magnifies, so it covers the original
  // instead of sitting beside a second copy of it.
  const deviceWidth = set.deviceWidth * U;
  const inset = deviceWidth * { iphone: 0.0295, ipad: 0.034, bare: 0 }[set.frame];
  const deviceScale = (deviceWidth - 2 * inset) / family.width;
  const centreY = (set.top / 100) * H + inset + (cy + ch / 2) * family.height * deviceScale;
  const top = centreY - height / 2;
  const url = captureUrl(family.capture, card.slide);
  const radius = set.family === "mac" ? 1.1 * U : 2.2 * U;
  return `<div style="position:absolute;left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${width.toFixed(1)}px;height:${height.toFixed(1)}px;
border-radius:${radius.toFixed(1)}px;overflow:hidden;background:#0b1020 url('${url}') no-repeat;
background-size:${(family.width * scale).toFixed(1)}px ${(family.height * scale).toFixed(1)}px;
background-position:${(-cx * family.width * scale).toFixed(1)}px ${(-cy * family.height * scale).toFixed(1)}px;
box-shadow:0 0 0 ${(0.2 * U).toFixed(2)}px rgba(255,255,255,.42), 0 ${(2.4 * U).toFixed(1)}px ${(5 * U).toFixed(1)}px rgba(0,0,0,.6), 0 0 ${(7 * U).toFixed(1)}px rgba(6,175,248,.3)"></div>`;
}

// ---- slices ----------------------------------------------------------------------------------

// One slice of a set's panorama: the whole strip is laid out in world coordinates and shifted so
// slide `index` fills the canvas. Only the neighbours that can reach into the slice are emitted.
function worldHtml(set, index) {
  const { width: W, height: H } = set;
  const total = COUNT * W;
  const mac = set.family === "mac";
  const family = families[set.family];
  const dw = set.deviceWidth * (W / 100);
  const devices = [];
  for (let j = Math.max(0, index - 1); j <= Math.min(COUNT - 1, index + 1); j++) {
    const left = j * W + (W - dw) / 2;
    devices.push(frames[set.frame](set, captureUrl(family.capture, j), left, (set.top / 100) * H));
  }
  const cards = zoomCards
    .filter((card) => {
      const seam = card.side === "right" ? card.slide + 1 : card.slide;
      return Math.abs(seam - index - 0.5) <= 0.5 + 1e-9 && seam >= 1 && seam < COUNT;
    })
    .map((card) => zoomCardHtml(set, card));
  return `<div style="position:absolute;left:${-index * W}px;top:0;width:${total}px;height:${H}px;background:${backdropCss(set, total)}">
${sceneSvg(set, index, total, mac ? 0.64 : 0.58, (t) => 0.9 * (1 - t) ** 1.8 + 0.04)}
${devices.join("\n")}
${cards.join("\n")}
</div>`;
}

function copyHtml(set, slide) {
  const U = set.width / 100;
  const u = (value) => `${(value * U).toFixed(2)}px`;
  const mac = set.family === "mac";
  const tablet = set.family === "tablet";
  const eyebrowSize = mac ? 0.95 : 2.0;
  const headlineSize = mac ? 4.4 : tablet ? 7.2 : 9.2;
  const icon = slide.hero
    ? `<img src="${iconUrl}" alt="" style="width:${u(mac ? 3.2 : 7.2)};height:${u(mac ? 3.2 : 7.2)};border-radius:${u(mac ? 0.75 : 1.6)};margin-right:${u(mac ? 0.9 : 2)};box-shadow:0 ${u(0.6)} ${u(1.6)} rgba(0,0,0,.5)">`
    : "";
  return `<div style="position:absolute;${mac ? `left:${u(5)};top:${u(4.6)};width:${u(70)}` : `left:${u(7)};right:${u(7)};top:${u(tablet ? 6.4 : 7)}`}">
<div style="display:flex;align-items:center;margin-bottom:${u(mac ? 1.1 : 2.4)}">${icon}
<span style="display:inline-flex;align-items:center;gap:${u(eyebrowSize * 0.55)};padding:${u(eyebrowSize * 0.42)} ${u(eyebrowSize * 0.95)};border-radius:999px;
background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 ${u(0.12)} rgba(255,255,255,.22);backdrop-filter:blur(8px);
font-size:${u(eyebrowSize)};letter-spacing:.16em;text-transform:uppercase;font-weight:650;color:#dff4ff">
<b style="width:${u(eyebrowSize * 0.5)};height:${u(eyebrowSize * 0.5)};border-radius:50%;background:${BRAND.cyan};box-shadow:0 0 ${u(eyebrowSize * 0.9)} ${BRAND.cyan}"></b>${escapeHtml(slide.eyebrow)}</span></div>
<h1 style="font-size:${u(headlineSize)};font-weight:790;line-height:1.03;letter-spacing:-.028em;color:#f6f9ff;${mac ? "text-wrap:balance;" : `max-width:${u(88)};`}">${headlineHtml(slide.headline, mac)}</h1></div>`;
}

function storeSlideHtml(set, index) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}
.canvas { position: relative; width: ${set.width}px; height: ${set.height}px; overflow: hidden; }
h1 em { font-style: normal; background: linear-gradient(90deg, #c8f2ff, #5fd0ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
</style></head><body><div class="canvas">
${worldHtml(set, index)}
${copyHtml(set, slides[index])}
</div></body></html>`;
}

// Google Play feature graphic (1024x500): the same scene with frameless screenshot cards, no
// device art, and the copy kept clear of the edges (Play crops it in some placements).
function featureGraphicHtml() {
  const total = 1024;
  const card = (index, left, top, width, rotate) => {
    const src = captureUrl(families.phone.capture, index);
    return `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;border-radius:${width * 0.075}px;overflow:hidden;transform:rotate(${rotate}deg);
box-shadow:0 0 0 1.5px rgba(255,255,255,.3), 0 26px 50px -8px rgba(0,0,0,.7), 0 0 40px rgba(6,175,248,.22)"><img src="${src}" style="display:block;width:100%" alt=""></div>`;
  };
  const bg = [
    `radial-gradient(420px 300px at 700px 90px, ${hexA(BRAND.cyan, 0.3)}, transparent)`,
    `radial-gradient(360px 280px at 1000px 470px, ${hexA(BRAND.violet, 0.4)}, transparent)`,
    `radial-gradient(380px 260px at 380px 520px, ${hexA(BRAND.cyan, 0.22)}, transparent)`,
    `linear-gradient(100deg, #070b14 0%, #031a63 40%, #0a3f9e 78%, #0a3591 100%)`,
  ].join(", ");
  // The scene helper draws three slides wide, starting one slide left of `slide`; slide 0 puts
  // the visible canvas at x 0..1024 of its strip.
  const scene = sceneSvg(
    { width: 1024, height: 500 },
    0,
    total * 3,
    0.9,
    (t) => 0.45 * (1 - t) ** 1.5 + 0.03,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseCss}
.canvas { position: relative; width: 1024px; height: 500px; overflow: hidden; color: #f6f9ff; background: ${bg}; }
.tag em { font-style: normal; background: linear-gradient(90deg, #c8f2ff, #5fd0ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
</style></head><body><div class="canvas">
${scene}
<img src="${iconUrl}" alt="" style="position:absolute;left:68px;top:92px;width:96px;height:96px;border-radius:22px;box-shadow:0 14px 36px rgba(0,0,0,.5)">
<div style="position:absolute;left:68px;top:206px;font-size:64px;font-weight:790;letter-spacing:-.032em">OpenMedia</div>
<div class="tag" style="position:absolute;left:70px;top:290px;width:420px;font-size:34px;font-weight:620;line-height:1.14;letter-spacing:-.015em;color:#d6e6ff">The web,<br><em>minus the noise.</em></div>
${card(1, 770, -60, 210, 8)}
${card(0, 560, 40, 210, -5)}
${card(5, 700, 250, 210, 3)}
</div></body></html>`;
}

// ---- rendering -------------------------------------------------------------------------------

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Chrome adds a transparent alpha channel and may pad the viewport; both stores reject alpha.
const flattenArgs = [
  "-background",
  BRAND.ink,
  "-alpha",
  "remove",
  "-alpha",
  "off",
  "-strip",
  "-define",
  "png:compression-level=9",
];

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
  run("magick", [
    rawFile,
    "-crop",
    `${width}x${height}+0+0`,
    "+repage",
    ...flattenArgs,
    `PNG24:${outFile}`,
  ]);
}

const args = process.argv.slice(2);
const wantStrip = args.includes("--panorama");
const only = args.find((arg) => !arg.startsWith("--"));
const workDir = mkdtempSync(path.join(tmpdir(), "openmedia-store-"));
try {
  if (!existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set CHROME_BIN.`);
  for (const set of sets) {
    const targets = [set.dir, ...(set.derive ?? []).map(([w, h]) => `macos/${w}x${h}`)];
    if (only && !targets.includes(only)) continue;
    const written = [];
    slides.forEach((slide, index) => {
      const name = `${String(index + 1).padStart(2, "0")}-${slide.slug}`;
      const outFile = path.join(storeDir, set.dir, `${name}.png`);
      renderPage(
        workDir,
        `${set.dir.replace("/", "-")}-${name}`,
        storeSlideHtml(set, index),
        set.width,
        set.height,
        outFile,
      );
      written.push(outFile);
      console.log(`${set.dir}/${name}.png  ${set.width}x${set.height}`);
      for (const [width, height] of set.derive ?? []) {
        const derived = path.join(storeDir, `macos/${width}x${height}`, `${name}.png`);
        mkdirSync(path.dirname(derived), { recursive: true });
        run("magick", [
          outFile,
          "-filter",
          "Lanczos",
          "-resize",
          `${width}x${height}!`,
          ...flattenArgs,
          `PNG24:${derived}`,
        ]);
        console.log(`macos/${width}x${height}/${name}.png  ${width}x${height}`);
      }
    });
    if (wantStrip) {
      const strip = `/tmp/openmedia-panorama-${set.dir.replace("/", "-")}.png`;
      run("magick", [...written, "+append", strip]);
      console.log(`strip -> ${strip}`);
    }
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
