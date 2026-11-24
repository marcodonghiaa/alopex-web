import { afterEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CategoryAvatar } from "./category-avatar";
import { CATEGORY_PALETTE, setCategoryLooks } from "@/lib/categories";

afterEach(() => setCategoryLooks([]));

describe("CategoryAvatar", () => {
  it("draws a line icon for a built-in category", () => {
    const { container } = render(<CategoryAvatar category="Groceries" />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toBe("");
    // Tinted in the category's own colour (Groceries).
    expect((container.firstChild as HTMLElement).style.color).not.toBe("");
  });

  it("shows the initial for a custom category", () => {
    const { container } = render(<CategoryAvatar category="Pets" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("P");
  });

  it("capitalises the initial and skips leading spaces", () => {
    const { container } = render(<CategoryAvatar category="  pet care" />);
    expect(container.textContent).toBe("P");
  });

  it("shows a dashed circle when there is no category", () => {
    for (const c of [null, "Uncategorized"]) {
      const { container, unmount } = render(<CategoryAvatar category={c} />);
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });

  it("draws the icon and colour picked in Settings, for own and built-in categories", () => {
    setCategoryLooks([
      { name: "Pets", icon: "pets", color: "orange" },
      { name: "Groceries", icon: "coffee", color: null },
    ]);
    const pets = render(<CategoryAvatar category="Pets" />).container;
    expect(pets.querySelector("[data-icon='pets']")).not.toBeNull();
    expect((pets.firstChild as HTMLElement).style.color).toBe("rgb(249, 115, 22)");
    const groceries = render(<CategoryAvatar category="Groceries" />).container;
    expect(groceries.querySelector("[data-icon='coffee']")).not.toBeNull();
  });

  it("previews a look before it is saved, at any size", () => {
    const { container } = render(
      <CategoryAvatar category="Holiday" size="lg" look={{ icon: "holiday", color: "cyan" }} />,
    );
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("size-14");
    expect(container.querySelector("[data-icon='holiday']")).not.toBeNull();
    expect(el.style.color).toBe("rgb(6, 182, 212)");
    const letter = render(
      <CategoryAvatar category="Holiday" size="sm" look={{ icon: null }} />,
    ).container;
    expect(letter.textContent).toBe("H");
    expect(CATEGORY_PALETTE.cyan).toBe("#06b6d4");
  });
});
