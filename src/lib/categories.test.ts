import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  categoriesFor,
  categoryColor,
  categoryIconName,
  categoryTone,
  checkCategoryName,
} from "./categories";

describe("categoryColor", () => {
  it("gives every built-in its own fixed colour", () => {
    expect(categoryColor("Shopping")).toBe("#ec4899");
    expect(categoryColor("Dine Out")).toBe("#f97316");
    const colors = CATEGORIES.map((c) => categoryColor(c));
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(colors).size).toBe(CATEGORIES.length);
  });

  it("falls back to the muted token for missing categories", () => {
    expect(categoryColor("Uncategorized")).toBe("var(--color-muted-foreground)");
    expect(categoryColor(null)).toBe("var(--color-muted-foreground)");
    expect(categoryColor(undefined)).toBe("var(--color-muted-foreground)");
  });
});

// A self-hoster wanted their own categories instead of the built-in ones.
describe("built-in looks", () => {
  it("keeps each built-in's colour and icon", () => {
    expect(CATEGORIES.map((c) => [c, categoryColor(c), categoryIconName(c)])).toEqual([
      ["Shopping", "#ec4899", "shopping"],
      ["Entertainment", "#8b5cf6", "entertainment"],
      ["Groceries", "#6366f1", "groceries"],
      ["Dine Out", "#f97316", "dine-out"],
      ["Services", "#3b82f6", "services"],
      ["Housing", "#14b8a6", "housing"],
      ["Transports", "#eab308", "transports"],
      ["Experiences", "#06b6d4", "experiences"],
      ["Income", "#84cc16", "income"],
      ["Health", "#d946ef", "health"],
      ["Transfer", "#64748b", "transfer"],
      ["Taxes", "#a16207", "taxes"],
      ["Others", "#94a3b8", "others"],
    ]);
    expect(categoryIconName("constructor")).toBeNull();
  });
});

describe("categoriesFor", () => {
  it("drops the built-ins you hid and adds your own at the end", () => {
    const list = categoriesFor([
      { name: "Taxes", hidden: true },
      { name: "Gym", hidden: false },
    ]);
    expect(list).not.toContain("Taxes");
    expect(list.at(-1)).toBe("Gym");
    expect(list).toContain("Transfer");
  });

  it("is the built-in list with no settings", () => {
    expect(categoriesFor([])).toEqual([...CATEGORIES]);
  });
});

describe("categoryColor for your own categories", () => {
  it("gives a custom category a colour, the same every time", () => {
    expect(categoryColor("Gym")).toMatch(/^#[0-9a-f]{6}$/);
    expect(categoryColor("Gym")).toBe(categoryColor("Gym"));
  });
});

describe("categoryTone", () => {
  it("maps rank 0 to the darkest tone and clamps ranks past 4 to the lightest", () => {
    expect(categoryTone(0)).toBe("var(--color-chart-1)");
    expect(categoryTone(3)).toBe("var(--color-chart-4)");
    expect(categoryTone(4)).toBe("var(--color-chart-5)");
    expect(categoryTone(12)).toBe("var(--color-chart-5)");
    expect(categoryTone(-1)).toBe("var(--color-chart-1)");
  });
});

// Polish 2 #2: a category named like an Object key still gets a colour string.
describe("categoryColor with prototype names", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])("%s hashes", (name) => {
    expect(categoryColor(name)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("checkCategoryName", () => {
  it("tidies spaces and accepts a free name", () => {
    expect(checkCategoryName("  Pet   care ", ["Groceries"])).toEqual({
      name: "Pet care",
      error: null,
    });
  });

  it("refuses a blank, a too-long or a taken name, ignoring case", () => {
    expect(checkCategoryName("   ", []).error).toBe("Type a name.");
    expect(checkCategoryName("x".repeat(41), []).error).toBe("At most 40 characters.");
    expect(checkCategoryName("x".repeat(40), []).error).toBeNull();
    expect(checkCategoryName("groceries", ["Groceries"]).error).toBe(
      '"groceries" is already in the list.',
    );
  });
});
