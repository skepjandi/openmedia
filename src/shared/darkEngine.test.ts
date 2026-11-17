import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  new URL("../../src-tauri/src/dark_mode/page.js", import.meta.url),
  "utf8",
);

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
interface Hsl {
  h: number;
  s: number;
  l: number;
}
type Theme = Record<string, unknown>;

interface Engine {
  parseColor: (text: string) => Rgba | null;
  rgbToHsl: (r: number, g: number, b: number) => Hsl;
  hslToRgb: (h: number, s: number, l: number) => { r: number; g: number; b: number };
  colorToCss: (c: Rgba) => string;
  buildTheme: (config?: Record<string, unknown>) => Theme;
  adjust: (c: Rgba, theme: Theme) => Rgba;
  modifyBackground: (c: Rgba, theme: Theme) => Rgba;
  modifyForeground: (c: Rgba, theme: Theme) => Rgba;
  modifyBorder: (c: Rgba, theme: Theme) => Rgba;
  rewriteValue: (prop: string, value: string, theme: Theme, base?: string) => string;
  rewriteDeclaration: (prop: string, value: string, theme: Theme) => string[][];
  rewriteDeclarations: (text: string, theme: Theme, base?: string, inline?: boolean) => string;
  rulesToCss: (rules: unknown[], theme: Theme, ctx: Record<string, unknown>) => string;
  scheduleActive: (
    schedule: { kind: string; from: string; to: string },
    now: Date,
    prefersDark: boolean,
  ) => boolean;
  resolveSite: (host: string, sites: Record<string, unknown>) => Record<string, unknown>;
  effectiveConfig: (
    config: Record<string, unknown>,
    site: Record<string, unknown>,
  ) => Record<string, unknown>;
  mergeFixes: (list: unknown) => { mode: string | null; method: string | null; invert: string[] };
  dynamicCss: (theme: Theme) => string;
  staticCss: (theme: Theme) => string;
  filterCss: (method: string, theme: Theme) => string;
  pageCss: (method: string, theme: Theme, invert: string[], images: boolean) => string;
  analysePixels: (
    data: number[],
    w: number,
    h: number,
  ) => {
    kind: string;
    luminance: number;
    transparency: number;
    saturation: number;
    whiteFraction: number;
  };
}

const OFF = { enabled: false };

function environment(extra: Record<string, unknown> = {}) {
  return vm.createContext({
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {},
    window: { location: { hostname: "example.com" } },
    ...extra,
  });
}

function engine(): Engine {
  const expose: Record<string, unknown> = {};
  const context = environment();
  const page = vm.runInContext(SOURCE, context) as (config: unknown) => void;
  page({ ...OFF, expose });
  return expose as unknown as Engine;
}

const E = engine();
const THEME = E.buildTheme();
const rgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const lightness = (c: Rgba) => E.rgbToHsl(c.r, c.g, c.b).l;
const hex = (c: Rgba) => E.colorToCss({ ...c, a: 1 });

describe("colour parsing", () => {
  it("reads every CSS notation", () => {
    expect(E.parseColor("#fff")).toMatchObject({ r: 255, g: 255, b: 255, a: 1 });
    expect(E.parseColor("#1a2B3c")).toMatchObject({ r: 26, g: 43, b: 60, a: 1 });
    expect(E.parseColor("#11223380")?.a).toBeCloseTo(0.502, 2);
    expect(E.parseColor("#abcd")?.a).toBeCloseTo(0.867, 2);
    expect(E.parseColor("rgb(10, 20, 30)")).toMatchObject({ r: 10, g: 20, b: 30, a: 1 });
    expect(E.parseColor("rgba(10,20,30,.5)")).toMatchObject({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(E.parseColor("rgb(10 20 30 / 25%)")).toMatchObject({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(E.parseColor("rgb(100%, 0%, 50%)")?.b).toBeCloseTo(127.5, 5);
    expect(E.parseColor("hsl(120, 100%, 25%)")?.g).toBeCloseTo(127.5, 5);
    expect(E.parseColor("hsla(0deg 100% 50% / .4)")).toMatchObject({ r: 255, g: 0, b: 0, a: 0.4 });
    expect(E.parseColor("hsl(0.5turn 100% 50%)")).toMatchObject({ r: 0, g: 255, b: 255 });
    expect(E.parseColor("transparent")).toMatchObject({ a: 0 });
    expect(E.parseColor("RebeccaPurple")).toMatchObject({ r: 102, g: 51, b: 153 });
    expect(E.parseColor("white")).toMatchObject({ r: 255, g: 255, b: 255 });
  });

  it("refuses what is not a colour", () => {
    for (const text of [
      "",
      "nope",
      "#12",
      "#12345",
      "rgb(1 2)",
      "var(--x)",
      "calc(1px)",
      "inherit",
    ]) {
      expect(E.parseColor(text), text).toBeNull();
    }
  });

  it("converts between RGB and HSL both ways", () => {
    const hsl = E.rgbToHsl(255, 0, 0);
    expect(hsl).toMatchObject({ h: 0, s: 1 });
    expect(hsl.l).toBeCloseTo(0.5);
    const back = E.hslToRgb(210, 0.5, 0.4);
    const again = E.rgbToHsl(back.r, back.g, back.b);
    expect(again.h).toBeCloseTo(210, 3);
    expect(again.s).toBeCloseTo(0.5, 3);
    expect(again.l).toBeCloseTo(0.4, 3);
    expect(E.rgbToHsl(128, 128, 128).s).toBe(0);
  });
});

describe("colour mapping", () => {
  it("folds white onto the scheme background", () => {
    const out = E.modifyBackground(rgb(255, 255, 255), THEME);
    expect(Math.abs(out.r - 24)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.g - 26)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.b - 27)).toBeLessThanOrEqual(1);
  });

  it("turns black text into the scheme text", () => {
    const out = E.modifyForeground(rgb(0, 0, 0), THEME);
    expect(Math.abs(out.r - 232)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.g - 230)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.b - 227)).toBeLessThanOrEqual(2);
  });

  it("gives a neutral grey the scheme hue", () => {
    const scheme = E.rgbToHsl(24, 26, 27);
    for (const grey of [rgb(128, 128, 128), rgb(200, 200, 200), rgb(20, 20, 20)]) {
      const out = E.rgbToHsl(
        ...(Object.values(E.modifyBackground(grey, THEME)).slice(0, 3) as [number, number, number]),
      );
      expect(out.h).toBeCloseTo(scheme.h, 0);
    }
    const border = E.modifyBorder(rgb(200, 200, 200), THEME);
    expect(E.rgbToHsl(border.r, border.g, border.b).h).toBeCloseTo(scheme.h, 0);
  });

  it("makes a blue link readable", () => {
    for (const link of ["#0000ee", "#0645ad", "#1a0dab", "navy", "#003399"]) {
      const out = E.modifyForeground(E.parseColor(link) as Rgba, THEME);
      expect(lightness(out), link).toBeGreaterThan(0.55);
      const hsl = E.rgbToHsl(out.r, out.g, out.b);
      expect(hsl.h, link).toBeGreaterThan(190);
      expect(hsl.h, link).toBeLessThan(270);
    }
  });

  it("keeps every background dark and every foreground light", () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const c = rgb(r, g, b);
          expect(lightness(E.modifyBackground(c, THEME)), `bg ${r},${g},${b}`).toBeLessThanOrEqual(
            0.45,
          );
          const fg = E.modifyForeground(c, THEME);
          expect(lightness(fg), `fg ${r},${g},${b}`).toBeGreaterThanOrEqual(0.45);
        }
      }
    }
  });

  it("keeps a dark panel dark and a mid border between background and text", () => {
    const panel = E.modifyBackground(rgb(40, 44, 52), THEME);
    expect(Math.abs(lightness(panel) - lightness(rgb(40, 44, 52)))).toBeLessThan(0.02);
    const border = lightness(E.modifyBorder(rgb(221, 221, 221), THEME));
    expect(border).toBeGreaterThan(0.1);
    expect(border).toBeLessThan(0.45);
  });

  it("preserves alpha", () => {
    expect(E.modifyBackground(rgb(255, 255, 255, 0.4), THEME).a).toBe(0.4);
    expect(E.modifyForeground(rgb(0, 0, 0, 0.7), THEME).a).toBe(0.7);
  });

  it("follows a custom scheme", () => {
    const theme = E.buildTheme({ background: "#000000", text: "#ffffff" });
    expect(hex(E.modifyBackground(rgb(255, 255, 255), theme))).toBe("#000000");
    expect(hex(E.modifyForeground(rgb(0, 0, 0), theme))).toBe("#ffffff");
  });
});

describe("brightness, contrast, sepia, grayscale", () => {
  const grey = rgb(100, 100, 100);

  it("is the identity at the defaults", () => {
    expect(E.adjust(rgb(10, 200, 90), THEME)).toMatchObject({ r: 10, g: 200, b: 90 });
  });

  it("scales with brightness", () => {
    const out = E.adjust(grey, E.buildTheme({ brightness: 150 }));
    expect(out.r).toBeCloseTo(150, 5);
    expect(E.adjust(grey, E.buildTheme({ brightness: 50 })).r).toBeCloseTo(50, 5);
    expect(E.adjust(rgb(200, 200, 200), E.buildTheme({ brightness: 150 })).r).toBe(255);
  });

  it("stretches around mid grey with contrast", () => {
    const high = E.adjust(rgb(178.5, 178.5, 178.5), E.buildTheme({ contrast: 150 }));
    expect(high.r).toBeCloseTo((178.5 / 255 - 0.5) * 1.5 * 255 + 127.5, 4);
    const low = E.adjust(rgb(255, 255, 255), E.buildTheme({ contrast: 50 }));
    expect(low.r).toBeCloseTo(191.25, 4);
  });

  it("matches the CSS sepia matrix", () => {
    const out = E.adjust(rgb(255, 0, 0), E.buildTheme({ sepia: 100 }));
    expect(out.r).toBeCloseTo(0.393 * 255, 3);
    expect(out.g).toBeCloseTo(0.349 * 255, 3);
    expect(out.b).toBeCloseTo(0.272 * 255, 3);
    const half = E.adjust(rgb(255, 0, 0), E.buildTheme({ sepia: 50 }));
    expect(half.r).toBeCloseTo((0.393 + 0.607 * 0.5) * 255, 3);
  });

  it("matches the CSS grayscale matrix", () => {
    const out = E.adjust(rgb(255, 0, 0), E.buildTheme({ grayscale: 100 }));
    expect(out.r).toBeCloseTo(0.2126 * 255, 3);
    expect(out.g).toBeCloseTo(0.2126 * 255, 3);
    expect(out.b).toBeCloseTo(0.2126 * 255, 3);
    const none = E.adjust(rgb(255, 0, 0), E.buildTheme({ grayscale: 0 }));
    expect(none.g).toBe(0);
  });

  it("is applied to mapped colours", () => {
    const plain = E.modifyBackground(rgb(255, 255, 255), THEME);
    const bright = E.modifyBackground(rgb(255, 255, 255), E.buildTheme({ brightness: 150 }));
    expect(bright.r).toBeGreaterThan(plain.r);
  });
});

describe("declaration rewriting", () => {
  const dark = (css: string) => E.rewriteValue("color", css, THEME);

  it("rewrites every colour in a value and leaves the rest", () => {
    const out = E.rewriteValue("background", "url(a.png) no-repeat #fff", THEME, "https://x.test/");
    expect(out).toBe("url(a.png) no-repeat #181a1b");
    expect(dark("rgba(0,0,0,.5)")).toMatch(/^rgba\(\d+, \d+, \d+, 0\.5\)$/);
    expect(dark("transparent")).toBe("transparent");
    expect(dark("currentcolor")).toBe("currentcolor");
    expect(E.rewriteValue("margin", "0 auto", THEME)).toBe("0 auto");
  });

  it("rewrites gradient colours and keeps the url", () => {
    const out = E.rewriteValue(
      "background",
      'linear-gradient(to right, #fff 0%, rgba(255,255,255,0) 40%, white), url("d.png")',
      THEME,
    );
    expect(out).toContain("linear-gradient(to right, #181a1b 0%,");
    expect(out).toContain('url("d.png")');
    expect(out).not.toMatch(/#fff|white/);
    expect(out).toContain("rgba(255,255,255,0) 40%");
  });

  it("rewrites box-shadow, border shorthands and text-shadow", () => {
    expect(
      E.rewriteValue("box-shadow", "0 1px 2px rgba(0,0,0,.2), inset 0 0 0 1px #fff", THEME),
    ).toMatch(/^0 1px 2px rgba\(24, 26, 27, 0\.2\), inset 0 0 0 1px #181a1b$/);
    const border = E.rewriteValue("border", "1px solid #ddd", THEME);
    expect(border).toMatch(/^1px solid #[0-9a-f]{6}$/);
    expect(border).not.toContain("#ddd");
    expect(E.rewriteValue("border-width", "1px", THEME)).toBe("1px");
    expect(E.rewriteValue("outline-color", "red", THEME)).not.toBe("red");
    expect(E.rewriteValue("text-shadow", "0 0 2px black", THEME)).not.toContain("black");
  });

  it("sends fill through the foreground mapper when dark and the background mapper when light", () => {
    const darkFill = E.rewriteValue("fill", "#000", THEME);
    expect(lightness(E.parseColor(darkFill) as Rgba)).toBeGreaterThan(0.8);
    const lightFill = E.rewriteValue("fill", "#fff", THEME);
    expect(lightness(E.parseColor(lightFill) as Rgba)).toBeLessThan(0.15);
  });

  it("routes var() to the dark variants", () => {
    expect(E.rewriteValue("color", "var(--ink)", THEME)).toBe("var(--om-text--ink,var(--ink))");
    expect(E.rewriteValue("background-color", "var(--paper, #fff)", THEME)).toBe(
      "var(--om-bg--paper,var(--paper,#181a1b))",
    );
    expect(E.rewriteValue("border-color", "var(--line)", THEME)).toBe(
      "var(--om-border--line,var(--line))",
    );
    expect(E.rewriteValue("fill", "var(--mark)", THEME)).toBe("var(--om-text--mark,var(--mark))");
  });

  it("emits the --om variants of a custom property", () => {
    const pairs = E.rewriteDeclaration("--paper", "#ffffff", THEME);
    expect(pairs.map((pair) => pair[0])).toEqual([
      "--om-bg--paper",
      "--om-text--paper",
      "--om-border--paper",
    ]);
    expect(pairs[1][1]).toBe("#ffffff");
    expect(pairs[0][1]).toBe("#181a1b");
    expect(E.rewriteDeclaration("--gap", "12px", THEME)).toEqual([]);
  });

  it("chains custom properties through the variants", () => {
    const pairs = E.rewriteDeclaration("--surface", "var(--paper)", THEME);
    expect(pairs[0]).toEqual(["--om-bg--surface", "var(--om-bg--paper,var(--paper))"]);
    expect(pairs[1][1]).toBe("var(--om-text--paper,var(--paper))");
  });

  it("rewrites a rule body and keeps important", () => {
    const css = E.rewriteDeclarations(
      "color: #000 !important; margin: 0; background: #fff; --x: #fff",
      THEME,
    );
    expect(css).toContain("color:#e8e6e3!important;");
    expect(css).toContain("background:#181a1b;");
    expect(css).toContain("--om-bg--x:#181a1b;");
    expect(css).not.toContain("margin");
  });

  it("emits only changed declarations, all important, for an inline style", () => {
    const css = E.rewriteDeclarations(
      "color: #000; margin: 0; width: 3px; background: transparent",
      THEME,
      "",
      true,
    );
    expect(css).toBe("color:#e8e6e3!important;");
  });

  it("mirrors a rule tree, keeping order for unchanged colour properties", () => {
    const style = (selector: string, text: string) => ({
      [Symbol.toStringTag]: "CSSStyleRule",
      selectorText: selector,
      style: { cssText: text },
    });
    const media = {
      [Symbol.toStringTag]: "CSSMediaRule",
      media: { mediaText: "(min-width: 600px)" },
      cssRules: [style(".b", "color: #333")],
    };
    const supports = {
      [Symbol.toStringTag]: "CSSSupportsRule",
      conditionText: "(display: grid)",
      cssRules: [style(".c", "margin: 0")],
    };
    const layer = {
      [Symbol.toStringTag]: "CSSLayerBlockRule",
      cssText: "@layer base { .d { color: #000 } }",
      cssRules: [style(".d", "background: #fff")],
    };
    const nested = {
      ...style(".e", "color: inherit"),
      cssRules: [style("& a", "color: #00e")],
    };
    const keyframes = {
      [Symbol.toStringTag]: "CSSKeyframesRule",
      name: "fade",
      cssRules: [
        { keyText: "from", style: { cssText: "background-color: #fff; opacity: 0" } },
        { keyText: "to", style: { cssText: "opacity: 1" } },
      ],
    };
    const out = E.rulesToCss(
      [
        style(".a", "color: #000; margin: 0"),
        style(".none", "margin: 0"),
        media,
        supports,
        layer,
        nested,
        keyframes,
      ],
      THEME,
      { base: "https://x.test/" },
    );
    expect(out).toContain(".a{color:#e8e6e3;}");
    expect(out).not.toContain(".none");
    expect(out).toContain("@media (min-width: 600px){.b{color:");
    expect(out).not.toContain("@supports");
    expect(out).toContain("@layer base{.d{background:#181a1b;}}");
    expect(out).toContain(".e{color:inherit;& a{color:");
    expect(out).toContain(
      "@keyframes fade{from{background-color:#181a1b;opacity:0;}to{opacity:1;}}",
    );
  });

  it("swaps a dark background icon for its inverted copy when the analyser has one", () => {
    const theme = E.buildTheme();
    theme.images = {
      lookup: (url: string) =>
        url === "https://x.test/i.png" ? "data:image/png;base64,AAA" : undefined,
    };
    expect(
      E.rewriteValue("background", "url(i.png) center / 16px, #fff", theme, "https://x.test/a.css"),
    ).toBe('url("data:image/png;base64,AAA") center / 16px, #181a1b');
    expect(E.rewriteValue("background", "url(other.png)", theme, "https://x.test/")).toBe(
      "url(other.png)",
    );
  });
});

describe("site and recipe resolution", () => {
  const sites = {
    "example.com": { mode: "off" },
    "news.example.com": { mode: "on", method: "static" },
    "a.org": {},
  };

  it("takes the longest registrable suffix", () => {
    expect(E.resolveSite("news.example.com", sites)).toEqual({ mode: "on", method: "static" });
    expect(E.resolveSite("deep.news.example.com", sites)).toEqual({ mode: "on", method: "static" });
    expect(E.resolveSite("www.example.com", sites)).toEqual({ mode: "off" });
    expect(E.resolveSite("example.com", sites)).toEqual({ mode: "off" });
  });

  it("does not match a lookalike or an unknown host", () => {
    expect(E.resolveSite("badexample.com", sites)).toEqual({});
    expect(E.resolveSite("example.com.evil.net", sites)).toEqual({});
    expect(E.resolveSite("other.net", sites)).toEqual({});
    expect(E.resolveSite("", sites)).toEqual({});
  });

  it("merges recipe fixes: first mode and method, every invert selector once", () => {
    const merged = E.mergeFixes([
      { invert: [".logo", ".chart"] },
      { mode: "on", method: "filter", invert: [".logo"] },
      { mode: "off", method: "static" },
      { mode: "sideways", method: "nope" },
      null,
    ]);
    expect(JSON.parse(JSON.stringify(merged))).toEqual({
      mode: "on",
      method: "filter",
      invert: [".logo", ".chart"],
    });
    expect(JSON.parse(JSON.stringify(E.mergeFixes(undefined)))).toEqual({
      mode: null,
      method: null,
      invert: [],
    });
  });
});

describe("schedule", () => {
  const at = (h: number, m: number) => new Date(2025, 0, 15, h, m);
  const always = { kind: "always", from: "21:00", to: "07:00" };
  const time = { kind: "time", from: "21:00", to: "07:00" };

  it("always is always", () => {
    expect(E.scheduleActive(always, at(12, 0), false)).toBe(true);
  });

  it("system follows the page's colour scheme", () => {
    expect(E.scheduleActive({ ...always, kind: "system" }, at(12, 0), true)).toBe(true);
    expect(E.scheduleActive({ ...always, kind: "system" }, at(12, 0), false)).toBe(false);
  });

  it("a window that wraps midnight", () => {
    expect(E.scheduleActive(time, at(21, 0), false)).toBe(true);
    expect(E.scheduleActive(time, at(23, 59), false)).toBe(true);
    expect(E.scheduleActive(time, at(0, 0), false)).toBe(true);
    expect(E.scheduleActive(time, at(6, 59), false)).toBe(true);
    expect(E.scheduleActive(time, at(7, 0), false)).toBe(false);
    expect(E.scheduleActive(time, at(12, 0), false)).toBe(false);
    expect(E.scheduleActive(time, at(20, 59), false)).toBe(false);
  });

  it("a window inside one day", () => {
    const day = { kind: "time", from: "08:00", to: "17:30" };
    expect(E.scheduleActive(day, at(8, 0), false)).toBe(true);
    expect(E.scheduleActive(day, at(17, 29), false)).toBe(true);
    expect(E.scheduleActive(day, at(17, 30), false)).toBe(false);
    expect(E.scheduleActive(day, at(7, 59), false)).toBe(false);
  });

  it("an unreadable time keeps it on", () => {
    expect(E.scheduleActive({ kind: "time", from: "late", to: "07:00" }, at(12, 0), false)).toBe(
      true,
    );
  });
});

describe("image analysis", () => {
  function pixels(width: number, height: number, paint: (x: number, y: number) => number[]) {
    const data: number[] = [];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.push(...paint(x, y));
    return data;
  }

  it("calls a dark glyph on a transparent field an icon", () => {
    const data = pixels(32, 32, (x, y) =>
      x > 8 && x < 24 && y > 8 && y < 24 ? [20, 20, 20, 255] : [0, 0, 0, 0],
    );
    const verdict = E.analysePixels(data, 32, 32);
    expect(verdict.kind).toBe("icon");
    expect(verdict.transparency).toBeGreaterThan(0.5);
    expect(verdict.luminance).toBeLessThan(0.2);
  });

  it("calls an opaque white drawing a diagram", () => {
    const data = pixels(64, 64, (x, y) =>
      x % 8 === 0 || y % 8 === 0 ? [40, 40, 40, 255] : [255, 255, 255, 255],
    );
    const verdict = E.analysePixels(data, 64, 64);
    expect(verdict.kind).toBe("diagram");
    expect(verdict.whiteFraction).toBeGreaterThan(0.6);
  });

  it("leaves a photo alone", () => {
    const data = pixels(64, 64, (x, y) => [(x * 4) % 256, (y * 4) % 256, ((x + y) * 3) % 256, 255]);
    expect(E.analysePixels(data, 64, 64).kind).toBe("photo");
  });

  it("leaves a white icon on transparent alone", () => {
    const data = pixels(16, 16, (x) => (x < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    expect(E.analysePixels(data, 16, 16).kind).toBe("photo");
  });

  it("copes with an empty image", () => {
    expect(
      E.analysePixels(
        pixels(4, 4, () => [0, 0, 0, 0]),
        4,
        4,
      ).kind,
    ).toBe("photo");
  });
});

describe("generated css", () => {
  it("builds the filter method", () => {
    const css = E.filterCss(
      "filter",
      E.buildTheme({ brightness: 110, contrast: 90, sepia: 10, grayscale: 20 }),
    );
    expect(css).toContain(
      "html{filter:invert(1) hue-rotate(180deg) brightness(1.1) contrast(0.9) sepia(0.1) grayscale(0.2)!important}",
    );
    expect(css).toContain(
      'img,video,canvas,svg image,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}',
    );
    expect(css).toContain("html{background-color:#ffffff}");
    expect(css).not.toContain("iframe");
  });

  it("paints the inverse of the scheme background for filterplus", () => {
    const css = E.filterCss("filterplus", THEME);
    const painted = /html\{background-color:(#[0-9a-f]{6})!important\}/.exec(css);
    expect(painted).not.toBeNull();
    const c = E.parseColor(painted?.[1] ?? "") as Rgba;
    const inverted = { r: 255 - c.r, g: 255 - c.g, b: 255 - c.b };
    const rotated = {
      r: -0.574 * inverted.r + 1.43 * inverted.g + 0.144 * inverted.b,
      g: 0.426 * inverted.r + 0.43 * inverted.g + 0.144 * inverted.b,
      b: 0.426 * inverted.r + 1.43 * inverted.g - 0.856 * inverted.b,
    };
    expect(Math.abs(rotated.r - 24)).toBeLessThan(2);
    expect(Math.abs(rotated.g - 26)).toBeLessThan(2);
    expect(Math.abs(rotated.b - 27)).toBeLessThan(2);
  });

  it("builds the static theme", () => {
    const css = E.staticCss(THEME);
    expect(css).toContain("html,body{background-color:#181a1b!important;color:");
    expect(css).toContain("input,textarea,select,button{background-color:");
    expect(css).toContain("::placeholder{");
    expect(css).toContain("table,th,td,hr{border-color:");
    const link = /a\{color:(#[0-9a-f]{6})!important\}/.exec(css);
    expect(lightness(E.parseColor(link?.[1] ?? "") as Rgba)).toBeGreaterThan(0.55);
  });

  it("builds the dynamic base with the early paint and form controls", () => {
    const css = E.dynamicCss(THEME);
    expect(css).toContain("html{background-color:#181a1b!important;color:#e8e6e3}");
    expect(css).toContain(":where(input,textarea,select,button){");
    for (const method of ["dynamic", "static", "filter", "filterplus"]) {
      expect(E.pageCss(method, THEME, [], true), method).not.toMatch(/NaN|undefined/);
    }
  });

  it("adds system controls, scrollbars, stroke and the invert fixes per option", () => {
    const full = E.pageCss("dynamic", E.buildTheme({ textStroke: 3 }), [".logo", ".chart"], true);
    expect(full).toContain(":root{color-scheme:dark}");
    expect(full).toContain("::-webkit-scrollbar{");
    expect(full).toContain("scrollbar-color:");
    expect(full).toContain("::selection{");
    expect(full).toContain("-webkit-text-stroke-width:0.3px");
    expect(full).toContain(":not(:is(i,svg,svg *");
    expect(full).toContain(".logo{filter:invert(1) hue-rotate(180deg)!important}");
    expect(full).toContain(".chart{filter:invert(1) hue-rotate(180deg)!important}");
    expect(full).toContain('[data-om-img="invert"]{filter:');

    const bare = E.pageCss(
      "dynamic",
      E.buildTheme({ systemControls: false, scrollbars: false, textStroke: 0 }),
      [],
      false,
    );
    expect(bare).not.toContain("color-scheme");
    expect(bare).not.toContain("scrollbar");
    expect(bare).not.toContain("::selection");
    expect(bare).not.toContain("text-stroke");
    expect(bare).not.toContain("data-om-img");
  });

  it("ignores invert fixes in the filter methods and flips the controls to light", () => {
    const css = E.pageCss("filter", THEME, [".logo"], true);
    expect(css).not.toContain(".logo");
    expect(css).not.toContain("data-om-img");
    expect(css).toContain(":root{color-scheme:light}");
    expect(E.pageCss("static", THEME, [".logo"], true)).toContain(".logo{filter:");
  });
});

interface FakeElement {
  localName: string;
  attributes: Record<string, string>;
  textContent: string;
  parentNode: FakeElement | null;
  children: FakeElement[];
  isConnected: boolean;
  disabled: boolean;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
  appendChild: (child: FakeElement) => FakeElement;
  remove: () => void;
}

function fakeElement(localName: string): FakeElement {
  const element: FakeElement = {
    localName,
    attributes: {},
    textContent: "",
    parentNode: null,
    children: [],
    isConnected: false,
    disabled: false,
    setAttribute(name, value) {
      element.attributes[name] = value;
    },
    hasAttribute: (name) => name in element.attributes,
    appendChild(child) {
      child.parentNode = element;
      child.isConnected = true;
      element.children.push(child);
      return child;
    },
    remove() {
      const parent = element.parentNode;
      if (parent) parent.children = parent.children.filter((child) => child !== element);
      element.parentNode = null;
      element.isConnected = false;
    },
  };
  return element;
}

class FakeObserver {
  static live = new Set<FakeObserver>();
  constructor(readonly callback: unknown) {}
  observe() {
    FakeObserver.live.add(this);
  }
  disconnect() {
    FakeObserver.live.delete(this);
  }
}

function pageWithDocument(options: { background: string; readyState?: string; hostname?: string }) {
  FakeObserver.live.clear();
  const root = fakeElement("html");
  root.isConnected = true;
  const listeners = new Map<string, unknown[]>();
  const intervals = new Set<unknown>();
  const document: Record<string | symbol, unknown> = {
    readyState: options.readyState ?? "complete",
    documentElement: root,
    body: fakeElement("body"),
    baseURI: "https://example.com/",
    createElement: fakeElement,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: unknown) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: unknown) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
      );
    },
  };
  const context = environment({
    document,
    window: {
      location: { hostname: options.hostname ?? "example.com" },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    },
    MutationObserver: FakeObserver,
    getComputedStyle: () => ({ backgroundColor: options.background, color: "rgb(0, 0, 0)" }),
    setInterval: (fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      intervals.add(handle);
      return handle;
    },
    clearInterval: (handle: ReturnType<typeof setInterval>) => {
      intervals.delete(handle);
      clearInterval(handle);
    },
  });
  const run = vm.runInContext(SOURCE, context) as (config: unknown) => void;
  return { document, root, run, listeners, intervals };
}

const KEY = Symbol.for("openmedia.darkMode");
const STATE = Symbol.for("openmedia.darkMode.state");
const FIXES = Symbol.for("openmedia.darkFixes");

describe("run in a page", () => {
  const ON = {
    enabled: true,
    method: "dynamic",
    schedule: { kind: "always", from: "21:00", to: "07:00" },
  };

  it("does nothing but tear down when everything is off", () => {
    const page = pageWithDocument({ background: "rgb(255, 255, 255)" });
    page.run(OFF);
    expect(page.root.children).toHaveLength(0);
    expect(page.document[KEY]).toBeUndefined();
    page.run({ ...ON, sites: { "example.com": { mode: "off" } } });
    expect(page.root.children).toHaveLength(0);
  });

  it("themes a light page, then removes everything it added", () => {
    const page = pageWithDocument({ background: "rgb(255, 255, 255)" });
    page.run({ ...ON, schedule: { kind: "time", from: "00:00", to: "23:59" } });
    expect(page.root.children.length).toBeGreaterThan(0);
    const base = page.root.children[0];
    expect(base.attributes["data-om-dark"]).toBe("");
    expect(base.textContent).toContain("html{background-color:#181a1b!important");
    expect(page.document[STATE]).toEqual({ active: true, reason: "enabled" });
    expect(FakeObserver.live.size).toBeGreaterThan(0);
    expect(page.intervals.size).toBeGreaterThan(0);

    (page.document[KEY] as () => void)();
    expect(page.root.children).toHaveLength(0);
    expect(page.document[KEY]).toBeUndefined();
    expect(page.document[STATE]).toBeUndefined();
    expect(FakeObserver.live.size).toBe(0);
    expect(page.intervals.size).toBe(0);
  });

  it("is re-runnable: a second run replaces the first", () => {
    const page = pageWithDocument({ background: "rgb(255, 255, 255)" });
    page.run(ON);
    const count = page.root.children.length;
    page.run({ ...ON, brightness: 120 });
    expect(page.root.children).toHaveLength(count);
    page.run(OFF);
    expect(page.root.children).toHaveLength(0);
    expect(FakeObserver.live.size).toBe(0);
  });

  it("leaves a page that is already dark alone and says why", () => {
    const page = pageWithDocument({ background: "rgb(18, 18, 18)" });
    page.run(ON);
    expect(page.root.children).toHaveLength(0);
    expect(page.document[STATE]).toEqual({ active: false, reason: "dark-page" });
    (page.document[KEY] as () => void)();
    expect(page.document[STATE]).toBeUndefined();
  });

  it("waits for DOMContentLoaded before judging a page that is still loading", () => {
    const page = pageWithDocument({ background: "rgb(18, 18, 18)", readyState: "loading" });
    page.run(ON);
    expect(page.root.children.length).toBeGreaterThan(0);
    const ready = page.listeners.get("DOMContentLoaded") ?? [];
    expect(ready).toHaveLength(1);
    page.document.readyState = "interactive";
    (ready[0] as () => void)();
    expect(page.root.children).toHaveLength(0);
    expect(page.document[STATE]).toEqual({ active: false, reason: "dark-page" });
  });

  it("forces the engine on past a dark-page check when the user or a recipe says on", () => {
    const user = pageWithDocument({ background: "rgb(18, 18, 18)" });
    user.run({ ...ON, enabled: false, sites: { "example.com": { mode: "on", method: "static" } } });
    expect(user.root.children).toHaveLength(1);
    expect(user.root.children[0].textContent).toContain(
      "html,body{background-color:#181a1b!important",
    );
    expect(user.document[STATE]).toEqual({ active: true, reason: "site-on" });

    const recipe = pageWithDocument({ background: "rgb(18, 18, 18)" });
    recipe.document[FIXES] = [{ mode: "on", method: "filter", invert: [".x"] }];
    recipe.run({ ...ON, enabled: false });
    expect(recipe.root.children[0].textContent).toContain("html{filter:invert(1)");
    expect(recipe.root.children[0].textContent).not.toContain(".x{");
    expect(recipe.document[STATE]).toEqual({ active: true, reason: "recipe-on" });
  });

  it("lets the user's site entry beat a recipe fix, and a recipe fix beat the global method", () => {
    const off = pageWithDocument({ background: "rgb(255, 255, 255)" });
    off.document[FIXES] = [{ mode: "on" }];
    off.run({ ...ON, sites: { "example.com": { mode: "off" } } });
    expect(off.root.children).toHaveLength(0);

    const method = pageWithDocument({ background: "rgb(255, 255, 255)" });
    method.document[FIXES] = [{ method: "static", invert: [".logo"] }];
    method.run(ON);
    expect(method.root.children[0].textContent).toContain("html,body{background-color:");
    expect(method.root.children[0].textContent).toContain(".logo{filter:");

    const user = pageWithDocument({ background: "rgb(255, 255, 255)" });
    user.document[FIXES] = [{ method: "static" }];
    user.run({ ...ON, sites: { "example.com": { method: "filterplus" } } });
    expect(user.root.children[0].textContent).toContain("html{filter:invert(1)");
  });

  it("stays off outside its schedule", () => {
    const page = pageWithDocument({ background: "rgb(255, 255, 255)" });
    page.run({ ...ON, schedule: { kind: "system", from: "21:00", to: "07:00" } });
    expect(page.root.children).toHaveLength(0);
    expect(page.document[STATE]).toEqual({ active: false, reason: "schedule" });
    (page.document[KEY] as () => void)();
  });
});

describe("a site's own settings over the global ones", () => {
  const GLOBAL = {
    enabled: true,
    method: "dynamic",
    brightness: 100,
    contrast: 100,
    sepia: 0,
    grayscale: 0,
    background: "#181a1b",
    text: "#e8e6e3",
    schedule: { kind: "system", from: "21:00", to: "07:00" },
    skipDarkPages: true,
    systemControls: true,
    scrollbars: true,
    images: true,
    textStroke: 0,
  };
  const effective = (site: Record<string, unknown>) =>
    E.effectiveConfig(GLOBAL, site) as Record<string, unknown>;

  it("follows the global settings for every field the entry leaves out", () => {
    expect(effective({})).toMatchObject(GLOBAL);
    expect(effective({ mode: "on" })).toMatchObject(GLOBAL);
  });

  it.each([
    ["method", "static"],
    ["brightness", 120],
    ["contrast", 70],
    ["sepia", 30],
    ["grayscale", 40],
    ["background", "#000000"],
    ["text", "#ffffff"],
    ["skipDarkPages", false],
    ["systemControls", false],
    ["scrollbars", false],
    ["images", false],
    ["textStroke", 4],
  ])("lets the site's %s beat the global one and nothing else", (key, value) => {
    const result = effective({ [key]: value });
    expect(result[key]).toBe(value);
    for (const other of Object.keys(GLOBAL).filter((name) => name !== key)) {
      expect(result[other], other).toEqual((GLOBAL as Record<string, unknown>)[other]);
    }
  });

  it("replaces the schedule as a whole", () => {
    const result = effective({ schedule: { kind: "time", from: "08:00", to: "09:00" } });
    expect(result.schedule).toEqual({ kind: "time", from: "08:00", to: "09:00" });
    expect(effective({ schedule: { kind: "always" } }).schedule).toEqual({
      kind: "always",
      from: "21:00",
      to: "07:00",
    });
  });

  it("ignores values of the wrong kind", () => {
    expect(effective({ brightness: "bright", method: "sepia", images: 1 })).toMatchObject(GLOBAL);
  });

  it("themes a page with the site's colours and schedule", () => {
    const plain = pageWithDocument({ background: "rgb(255, 255, 255)" });
    plain.run({ ...GLOBAL, method: "static", schedule: { kind: "always" } });
    expect(plain.root.children[0].textContent).toContain("#181a1b");

    const own = pageWithDocument({ background: "rgb(255, 255, 255)" });
    own.run({
      ...GLOBAL,
      method: "static",
      schedule: { kind: "always" },
      sites: { "example.com": { background: "#102030" } },
    });
    expect(own.root.children[0].textContent).toContain("#102030");
    expect(own.root.children[0].textContent).not.toContain("#181a1b");
  });

  it("runs on the site's schedule, not the global one", () => {
    const outside = pageWithDocument({ background: "rgb(255, 255, 255)" });
    outside.run({ ...GLOBAL, method: "static" });
    expect(outside.root.children).toHaveLength(0);
    expect(outside.document[STATE]).toEqual({ active: false, reason: "schedule" });

    const own = pageWithDocument({ background: "rgb(255, 255, 255)" });
    own.run({
      ...GLOBAL,
      method: "static",
      sites: { "example.com": { schedule: { kind: "always", from: "21:00", to: "07:00" } } },
    });
    expect(own.root.children).toHaveLength(1);
    expect(own.document[STATE]).toEqual({ active: true, reason: "enabled" });

    const global = pageWithDocument({ background: "rgb(255, 255, 255)" });
    global.run({
      ...GLOBAL,
      method: "static",
      schedule: { kind: "always" },
      sites: { "example.com": { schedule: { kind: "system", from: "21:00", to: "07:00" } } },
    });
    expect(global.root.children).toHaveLength(0);
  });

  it("lets the site's skip-dark-pages choice decide whether a dark page is left alone", () => {
    const skipped = pageWithDocument({ background: "rgb(18, 18, 18)" });
    skipped.run({ ...GLOBAL, schedule: { kind: "always" } });
    expect(skipped.document[STATE]).toEqual({ active: false, reason: "dark-page" });

    const themed = pageWithDocument({ background: "rgb(18, 18, 18)" });
    themed.run({
      ...GLOBAL,
      schedule: { kind: "always" },
      sites: { "example.com": { skipDarkPages: false } },
    });
    expect(themed.document[STATE]).toEqual({ active: true, reason: "enabled" });
  });

  it("keeps recipe fixes below the site's method and above the global one", () => {
    const page = pageWithDocument({ background: "rgb(255, 255, 255)" });
    page.document[FIXES] = [{ method: "filter" }];
    page.run({
      ...GLOBAL,
      schedule: { kind: "always" },
      sites: { "example.com": { brightness: 120 } },
    });
    expect(page.root.children[0].textContent).toContain("html{filter:invert(1)");
  });
});
