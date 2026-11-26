import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "styles.css"), "utf8");

describe("global styles", () => {
  // Regression: iOS Safari gives <input type="date"> a wide built-in minimum
  // width, so in the trades dialog's two-column grid the Date field ran past
  // the dialog's edge. jsdom has no layout, so check the rule that fixes it.
  it("lets date inputs shrink to their column on iOS", () => {
    const rule = css.match(/input\[type="date"\]\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/-webkit-appearance:\s*none/);
  });

  // iOS view (fonts, Marco): every number in Geist, like Net Worth's figure. Even-width digits keep
  // amount columns aligned without a monospace font.
  it("sets figures in Geist with even-width digits", () => {
    expect(css).toMatch(/--font-figure:\s*"Geist Variable"/);
    const rule = css.match(/@utility font-figure\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/tabular-nums/);
    expect(rule).not.toMatch(/font-weight/);
  });
});

// Re-audit N1: 12 px Ember counts (nav badge, filter count) were 2.92:1 on the light sidebar.
// They use --ember-text, darker in light theme only; the global --ember stays as it is.
describe("ember text for small counts", () => {
  const oklch = (v: string) =>
    v
      .match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/)!
      .slice(1)
      .map(Number);
  const luminance = ([L, C, h]: Array<number>) => {
    const a = C! * Math.cos((h! * Math.PI) / 180);
    const b = C! * Math.sin((h! * Math.PI) / 180);
    const l = (L! + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L! - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L! - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (x: number) => Math.min(1, Math.max(0, x));
    const r = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bl = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const contrast = (x: string, y: string) => {
    const [p, q] = [luminance(oklch(x)), luminance(oklch(y))];
    return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05);
  };
  const light = css.slice(
    css.indexOf(":root {"),
    css.indexOf("@media (prefers-color-scheme: dark)"),
  );
  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  const token = (block: string, name: string) =>
    block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1] ?? "";

  it("reads at 4.5:1 or more on the light sidebar and page", () => {
    const text = token(light, "ember-text");
    expect(contrast(text, token(light, "sidebar"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, token(light, "background"))).toBeGreaterThanOrEqual(4.5);
    // the active sidebar row: 5% ink over the sidebar, about L 0.955
    expect(contrast(text, "oklch(0.955 0.004 230)")).toBeGreaterThanOrEqual(4.5);
  });

  // H329: the focus ring was --ember, 2.92:1 on the light page (WCAG 1.4.11 asks 3:1).
  it("draws the focus ring at 3:1 or more on the page, cards and sidebar, light and dark", () => {
    const value = (block: string, name: string): string => {
      const v = token(block, name);
      const ref = v.match(/^var\(--([\w-]+)\)$/)?.[1];
      return ref ? value(block === dark && !token(dark, ref) ? light : block, ref) : v;
    };
    for (const theme of [light, dark]) {
      for (const ring of ["ring", "sidebar-ring"]) {
        for (const ground of ["background", "card", "sidebar"]) {
          expect(contrast(value(theme, ring), value(theme, ground))).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it("leaves the global ember and the dark theme as they were", () => {
    expect(token(light, "ember")).toBe("oklch(0.68 0.16 50)");
    expect(token(dark, "ember-text")).toBe("var(--ember)");
    expect(css).toMatch(/--color-ember-text:\s*var\(--ember-text\)/);
  });
});
