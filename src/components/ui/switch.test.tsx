import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";

const track = () => screen.getByRole("switch").nextElementSibling!;

// protects=polish-4 V1/A2/A4: the shared switch follows Arctic Ledger (ink, not gain green),
// its off state is visible (WCAG 1.4.11) and it holds still under reduced motion
describe("Switch", () => {
  it("is ink when on, never the gain green, and has no thumb shadow", () => {
    render(<Switch aria-label="x" defaultChecked />);
    expect(track()).toHaveClass(
      "peer-checked:bg-primary",
      "peer-checked:after:bg-primary-foreground",
    );
    expect(track().className).not.toMatch(/positive|after:shadow/);
  });

  it("draws the off track dark enough to see on a white row", () => {
    render(<Switch aria-label="x" />);
    expect(track()).toHaveClass("bg-foreground/45");
  });

  it("drops its slide under reduced motion", () => {
    render(<Switch aria-label="x" />);
    expect(track()).toHaveClass(
      "motion-reduce:transition-none",
      "motion-reduce:after:transition-none",
    );
  });
});
