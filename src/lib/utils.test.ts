import { describe, expect, it } from "vitest";
import { tinted } from "./utils";

describe("tinted", () => {
  it("draws the colour on a 16% wash of it over the card", () => {
    expect(tinted("#ec4899")).toEqual({
      color: "#ec4899",
      backgroundColor: "color-mix(in oklab, #ec4899 16%, var(--color-card))",
    });
  });
});
