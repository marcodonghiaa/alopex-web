import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeadlineFigure } from "./headline-figure";

const css = readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");

describe("figure-display (HeadlineFigure)", () => {
  afterEach(() => {
    Object.defineProperty(navigator, "language", { value: "en-GB", configurable: true });
  });

  // Regression: a total of about €10 billion ran past a 375px screen and made the
  // page scroll sideways. jsdom has no layout, so check the rule that fixes it.
  it("lets a very long amount wrap instead of widening the page", () => {
    const rule = css.match(/@utility figure-display\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/font-weight:\s*700/);
    // Bold sans like the big broker apps, not the mono figure face (iOS view board).
    expect(rule).toMatch(/font-family:\s*var\(--font-sans\)/);
  });

  it("keeps cents and symbol at full size: cents at 55%, symbol muted", () => {
    const { container } = render(<HeadlineFigure value={1234.5} currency="EUR" />);
    const figure = container.querySelector(".figure-display")!;
    expect(figure).toHaveTextContent("€1,234.50");
    const cents = [...figure.querySelectorAll(".opacity-55")];
    expect(cents.map((c) => c.textContent).join("")).toBe(".50");
    expect(cents[0]!.className).not.toMatch(/text-\[0\.5em\]/);
    expect(screen.getByText("€").className).toContain("text-muted-foreground");
  });

  it("keeps the symbol muted when the locale writes it after the cents", () => {
    Object.defineProperty(navigator, "language", { value: "de-DE", configurable: true });
    const { container } = render(<HeadlineFigure value={1234.5} currency="EUR" />);
    const figure = container.querySelector(".figure-display")!;
    expect(figure.textContent).toBe("1.234,50\u00a0€");
    const cents = [...figure.querySelectorAll(".opacity-55")].map((c) => c.textContent).join("");
    expect(cents).toBe(",50");
    expect(screen.getByText("€").className).toContain("text-muted-foreground");
  });

  it("has no delta line unless asked", () => {
    render(<HeadlineFigure value={10} currency="EUR" />);
    expect(screen.queryByText("Month")).not.toBeInTheDocument();
  });

  it("colours the delta by sign and sets the label muted", () => {
    const { rerender } = render(
      <HeadlineFigure
        value={10}
        currency="EUR"
        delta={{ value: 12.5, percent: 0.012, label: "Month" }}
      />,
    );
    const gain = screen.getByText(/\+€12\.50 \(\+1\.2%\)/);
    expect(gain.className).toContain("font-figure");
    expect(gain.className).toContain("text-positive");
    expect(screen.getByText("Month").className).toContain("text-muted-foreground");

    rerender(<HeadlineFigure value={10} currency="EUR" delta={{ value: -3, label: "YTD" }} />);
    expect(screen.getByText("−€3.00").className).toContain("text-negative");

    rerender(<HeadlineFigure value={10} currency="EUR" delta={{ value: 0, label: "Today" }} />);
    expect(screen.getByText("€0.00").className).toContain("text-foreground");
  });

  // Polish 3 #8: the same minus as the signed figures beside it (formatSignedEur), not a hyphen.
  it("writes a negative amount with a real minus sign", () => {
    const { container } = render(<HeadlineFigure value={-1234.5} currency="EUR" />);
    expect(container.textContent).toBe("−€1,234.50");
  });

  // iOS view board: the change sits beside the figure, Trade Republic style; a tap swaps % and amount.
  it("shows the change as a percent beside the figure and swaps to the amount on tap", () => {
    render(
      <HeadlineFigure
        value={1000}
        currency="EUR"
        change={{ value: 250, percent: 0.25, className: "text-positive" }}
      />,
    );
    const chip = screen.getByRole("button", { name: /show change as amount/i });
    expect(chip).toHaveTextContent("▲ 25.00%");
    expect(chip.className).toContain("text-positive");
    chip.click();
  });

  it("shows a fall with a down arrow and the amount after a tap", async () => {
    const { findByRole } = render(
      <HeadlineFigure
        value={1000}
        currency="EUR"
        change={{ value: -250, percent: -0.2, className: "text-negative" }}
      />,
    );
    const chip = screen.getByRole("button", { name: /show change as amount/i });
    expect(chip).toHaveTextContent("▼ 20.00%");
    chip.click();
    expect(await findByRole("button", { name: /show change as percent/i })).toHaveTextContent(
      "▼ €250.00",
    );
  });

  it("shows the amount when there is no percent to show", () => {
    render(
      <HeadlineFigure
        value={1000}
        currency="EUR"
        change={{ value: 5, percent: null, className: "" }}
      />,
    );
    expect(screen.getByText("▲ €5.00")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
