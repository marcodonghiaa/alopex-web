import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { RangeChange, rangeChip } from "./value-history";
import type { ValueHistory } from "@/lib/use-value-history";

type Point = NonNullable<ValueHistory["first"]>;
const day = (snapshot_date: string) => ({ snapshot_date }) as Point;

describe("RangeChange", () => {
  // iOS view board: the amount and % moved into the chip beside the figure; only the range stays.
  it("names the selected range only, as on Net Worth", () => {
    render(<RangeChange delta={200} change={0.2} first={day("2025-12-31")} range="YTD" />);
    expect(screen.getByText("Year to date")).toBeInTheDocument();
    expect(screen.queryByText(/€200/)).toBeNull();
  });

  it("while scrubbing, names the days it spans", () => {
    render(
      <RangeChange
        delta={-50}
        change={-0.05}
        first={day("2026-10-10")}
        scrubbed={day("2026-11-01")}
        range="1M"
      />,
    );
    expect(screen.getByText(/10 Oct 2026 – 1 Nov 2026/)).toBeInTheDocument();
    expect(screen.queryByText("Past month")).not.toBeInTheDocument();
  });

  it("says nothing without a start to compare with", () => {
    const { container } = render(
      <RangeChange delta={null} change={null} first={undefined} range="ALL" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("rangeChip", () => {
  it("is the change beside the figure, toned by the return band", () => {
    expect(rangeChip({ delta: 200, change: 0.2 })).toEqual({
      value: 200,
      percent: 0.2,
      className: "text-positive",
    });
    expect(rangeChip({ delta: -50, change: -0.05 })?.className).toBe("text-negative");
  });

  it("is absent without a start to compare with", () => {
    expect(rangeChip({ delta: null, change: null })).toBeUndefined();
  });
});
