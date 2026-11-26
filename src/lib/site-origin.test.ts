import { describe, expect, it } from "vitest";
import { ogImageUrl, siteOrigin } from "./site-origin";

// H351: og:image named the author's domain on every self-hosted copy.
describe("ogImageUrl", () => {
  it("points at the copy's own origin", () => {
    expect(ogImageUrl("https://money.example.org")).toBe("https://money.example.org/og-image.png");
  });

  it("is relative when the origin is unknown", () => {
    expect(ogImageUrl("")).toBe("/og-image.png");
  });

  it("knows no origin outside a request", () => {
    expect(siteOrigin()).toBe("");
  });
});
