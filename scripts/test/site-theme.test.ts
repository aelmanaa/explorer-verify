// The colours of the docs site theme (#373): each text colour that site/.vitepress/theme/style.css
// sets keeps at least 4.5:1 on the backgrounds it sits on, in the light and the dark theme (WCAG
// 2.2 AA, 1.4.3), and the focus ring keeps 3:1 (1.4.11). The test reads VitePress's own variables,
// then the theme's overrides, and puts a translucent colour over the surface below it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/** The root of this repository. */
const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const THEME_CSS = path.join(REPOSITORY, "site/.vitepress/theme/style.css");
const VITEPRESS_VARS = path.join(
  path.dirname(createRequire(import.meta.url).resolve("vitepress/package.json")),
  "dist/client/theme-default/styles/vars.css",
);

type Rgba = [number, number, number, number];
type Variables = Map<string, string>;

/** The custom properties of the `:root` and `.dark` rules of a stylesheet, outside any comment. */
function variablesOf(css: string): { light: Variables; dark: Variables } {
  const light: Variables = new Map();
  const dark: Variables = new Map();
  const text = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector = "", body = ""] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const target = { ":root": light, ".dark": dark }[selector.trim()];
    if (target === undefined) {
      continue;
    }
    for (const [, name = "", value = ""] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      target.set(name, value.trim().replaceAll(/\s+/g, " "));
    }
  }
  return { light, dark };
}

/** The variables of each theme: VitePress's, then the site's; the dark theme inherits the light. */
function themes(): { light: Variables; dark: Variables } {
  const vitepress = variablesOf(readFileSync(VITEPRESS_VARS, "utf8"));
  const site = variablesOf(readFileSync(THEME_CSS, "utf8"));
  const light = new Map([...vitepress.light, ...site.light]);
  return { light, dark: new Map([...light, ...vitepress.dark, ...site.dark]) };
}

/** A colour value with each `var()` resolved, as RGBA with alpha from 0 to 1. */
function colour(variables: Variables, value: string): Rgba {
  const reference = /^var\((--[\w-]+)\)$/.exec(value);
  if (reference !== null) {
    const next = variables.get(String(reference[1]));
    assert.ok(next !== undefined, `${String(reference[1])} is not set`);
    return colour(variables, next);
  }
  const hex = /^#([\da-f]{6})$/i.exec(value);
  if (hex !== null) {
    const digits = String(hex[1]);
    const channel = (at: number): number => Number.parseInt(digits.slice(at, at + 2), 16);
    return [channel(0), channel(2), channel(4), 1];
  }
  const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
  assert.ok(rgba !== null, `${value} is not a #rrggbb or rgba() colour`);
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
}

/** A colour over an opaque background. */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

/** The linear value of one sRGB channel from 0 to 255 (WCAG 2.2). */
function linear(value: number): number {
  const c = value / 255;
  return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of an opaque colour (WCAG 2.2). */
function luminance([r, g, b]: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The contrast ratio of two opaque colours. */
function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (Number(high) + 0.05) / (Number(low) + 0.05);
}

/**
 * The pairs to check: a foreground variable, the variables of the layers below it from the top,
 * ending on an opaque surface, the smallest ratio and where the pair appears.
 */
const PAIRS: [string, string[], number, string][] = [
  ["--vp-c-brand-1", ["--vp-c-bg"], 4.5, "links, the active nav item, the hero name accent"],
  ["--vp-c-brand-1", ["--vp-c-bg-alt"], 4.5, "the active sidebar item"],
  ["--vp-c-brand-1", ["--vp-c-bg-soft"], 4.5, "links in the search box and outline"],
  ["--vp-c-brand-2", ["--vp-c-bg"], 4.5, "a link on hover"],
  ["--vp-c-brand-1", ["--ev-feature-bg"], 4.5, "the link of a home feature card"],
  ["--vp-c-text-1", ["--ev-feature-bg"], 4.5, "the title of a home feature card"],
  ["--vp-c-text-2", ["--ev-feature-bg"], 4.5, "the text of a home feature card"],
  ["--ev-title-color", ["--vp-nav-bg-color"], 4.5, "the header wordmark"],
  ["--vp-home-hero-name-color", ["--vp-c-bg"], 4.5, "the home page's name"],
  ["--vp-button-brand-text", ["--vp-button-brand-bg"], 4.5, "a brand button"],
  ["--vp-button-brand-hover-text", ["--vp-button-brand-hover-bg"], 4.5, "a hovered button"],
  ["--vp-button-brand-active-text", ["--vp-button-brand-active-bg"], 4.5, "a pressed button"],
  ["--vp-c-text-1", ["--vp-custom-block-tip-bg", "--vp-c-bg"], 4.5, "a tip block"],
  ["--vp-c-brand-1", ["--vp-custom-block-tip-bg", "--vp-c-bg"], 4.5, "a link in a tip block"],
  ["--vp-c-text-1", ["--vp-custom-block-info-bg", "--vp-c-bg"], 4.5, "an info block"],
  ["--vp-c-brand-1", ["--vp-custom-block-info-bg", "--vp-c-bg"], 4.5, "a link in an info block"],
  ["--vp-badge-tip-text", ["--vp-badge-tip-bg", "--vp-c-bg"], 4.5, "a tip badge"],
  ["--vp-badge-info-text", ["--vp-badge-info-bg", "--vp-c-bg"], 4.5, "an info badge"],
  ["--vp-code-color", ["--vp-code-bg", "--vp-c-bg"], 4.5, "inline code"],
  ["--vp-c-text-1", ["--vp-code-block-bg"], 4.5, "a code block's plain text"],
  ["--vp-local-search-highlight-text", ["--vp-local-search-highlight-bg"], 4.5, "a search match"],
  ["--vp-c-brand-1", ["--vp-c-bg"], 3, "the focus ring"],
];

/** The ratio of one pair in one theme. */
function ratioOf(variables: Variables, [fg, layers]: (typeof PAIRS)[number]): number {
  const surfaces = layers.map((name) => colour(variables, `var(${name})`));
  const base = surfaces.pop();
  assert.ok(base !== undefined && base[3] === 1, `${layers.join(" over ")} ends on no surface`);
  const background = surfaces.reduceRight((below, layer) => over(layer, below), base);
  return contrast(over(colour(variables, `var(${fg})`), background), background);
}

describe("the docs site theme's colours (#373)", () => {
  const { light, dark } = themes();

  const modes: [string, Variables][] = [
    ["light", light],
    ["dark", dark],
  ];
  for (const [name, variables] of modes) {
    for (const pair of PAIRS) {
      const [fg, layers, minimum, where] = pair;
      it(`${name}: ${where}, ${fg} on ${layers.join(" over ")}, is at least ${minimum}:1`, () => {
        const ratio = ratioOf(variables, pair);
        assert.ok(ratio >= minimum, `${ratio.toFixed(2)}:1 is below ${minimum}:1`);
      });
    }

    it(`${name}: a code block stands out from the page`, () => {
      assert.notDeepEqual(
        colour(variables, "var(--vp-code-block-bg)"),
        colour(variables, "var(--vp-c-bg)"),
      );
    });
  }

  it("sets the brand colours of the logo", () => {
    assert.equal(light.get("--vp-c-brand-1"), "#3346d3");
    assert.equal(dark.get("--vp-c-brand-1"), "#93a4ff");
    assert.equal(dark.get("--vp-button-brand-bg"), "#3346d3");
  });
});
