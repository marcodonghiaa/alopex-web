import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Icon, iconOf, isIconName } from "./icon";
import { CATEGORY_ICON_NAMES, ICON_LABELS, ICON_NODES } from "./icon-nodes";
import { CATEGORIES } from "@/lib/categories";

describe("Alopex icons", () => {
  it("draws an icon on the shared grid and stroke, in the text colour", () => {
    const { container } = render(<Icon name="crypto" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.children).toHaveLength(ICON_NODES.crypto.length);
  });

  it("is named for screen readers when given a label", () => {
    const { container } = render(<Icon name="search" aria-label="Search" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  it("iconOf makes a component that passes the class on", () => {
    const Budgets = iconOf("budgets");
    const { container } = render(<Budgets className="size-5" />);
    expect(container.querySelector("svg")!.getAttribute("class")).toBe("size-5");
    expect(container.querySelector("[data-icon='budgets']")).not.toBeNull();
  });

  it("knows its own names only", () => {
    expect(isIconName("pets")).toBe(true);
    for (const bad of ["constructor", "toString", "", null, 3, "<svg>"])
      expect(isIconName(bad)).toBe(false);
  });

  it("every icon is plain stroked shapes: no colours, fills other than none, scripts or links", () => {
    for (const [name, nodes] of Object.entries(ICON_NODES)) {
      expect(nodes.length, name).toBeGreaterThan(0);
      for (const [tag, attrs] of nodes) {
        expect(["path", "circle", "rect"], name).toContain(tag);
        for (const [k, v] of Object.entries(attrs)) {
          expect(
            ["d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "strokeDasharray"],
            `${name} ${k}`,
          ).toContain(k);
          expect(v, name).not.toMatch(/[<>"#]/);
        }
      }
    }
  });

  it("the picker offers only real icons, each with a label, and every built-in category has one", () => {
    for (const n of CATEGORY_ICON_NAMES) {
      expect(isIconName(n), n).toBe(true);
      expect(ICON_LABELS[n], n).toBeTruthy();
    }
    expect(CATEGORY_ICON_NAMES.length).toBeGreaterThanOrEqual(60);
    // The backend names a renamed built-in's icon from its name ("Dine Out" -> "dine-out").
    for (const c of CATEGORIES)
      expect(isIconName(c.toLowerCase().replace(/ /g, "-")), c).toBe(true);
  });
});
