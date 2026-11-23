import { afterEach, describe, expect, it } from "vitest";
import {
  CATEGORY_PALETTE,
  categoryColor,
  categoryIconName,
  isPaletteColor,
  pickedColor,
  setCategoryLooks,
} from "./categories";

afterEach(() => setCategoryLooks([]));

// A user wanted to pick each category's icon and colour (Settings › Categories).
describe("category looks", () => {
  it("built-in categories keep their icon and colour until you pick others", () => {
    expect(categoryIconName("Dine Out")).toBe("dine-out");
    expect(categoryColor("Groceries")).toBe("#6366f1");
    expect(pickedColor("Groceries")).toBeNull();
  });

  it("uses the icon and colour you picked, for built-in and own categories", () => {
    setCategoryLooks([
      { name: "Groceries", icon: "coffee", color: "green" },
      { name: "Pets", icon: "pets", color: "orange" },
    ]);
    expect(categoryIconName("Groceries")).toBe("coffee");
    expect(categoryColor("Groceries")).toBe(CATEGORY_PALETTE.green);
    expect(categoryIconName("Pets")).toBe("pets");
    expect(categoryColor("Pets")).toBe(CATEGORY_PALETTE.orange);
    expect(pickedColor("Pets")).toBe("orange");
  });

  it("own categories with nothing picked: no icon (their letter) and a colour from the name", () => {
    setCategoryLooks([{ name: "Holiday", icon: null, color: null }]);
    expect(categoryIconName("Holiday")).toBeNull();
    expect(categoryColor("Holiday")).toBe(categoryColor("Holiday"));
    expect(categoryColor("Holiday")).toMatch(/^#/);
  });

  it("an unknown colour name falls back to the default", () => {
    setCategoryLooks([{ name: "Groceries", color: "constructor" }]);
    expect(pickedColor("Groceries")).toBeNull();
    expect(categoryColor("Groceries")).toBe("#6366f1");
    expect(isPaletteColor("toString")).toBe(false);
  });

  it("no category: no icon, muted colour", () => {
    expect(categoryIconName(null)).toBeNull();
    expect(categoryIconName("Uncategorized")).toBeNull();
    expect(categoryColor(undefined)).toBe("var(--color-muted-foreground)");
  });

  it("every colour the backend gives a renamed built-in is in the palette", () => {
    // Kept in step with move_category in the backend migration 20261221000000_category_look_and_move.
    const fromBackend = [
      "pink",
      "violet",
      "indigo",
      "orange",
      "blue",
      "teal",
      "yellow",
      "cyan",
      "fuchsia",
      "brown",
      "gray",
    ];
    for (const n of fromBackend) expect(isPaletteColor(n), n).toBe(true);
  });
});
