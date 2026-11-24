import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { latestDot, ValueChart } from "./value-chart";

// jsdom has no layout (nor ResizeObserver): the chart itself isn't needed, only its wrapper.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: () => null,
}));

describe("latestDot", () => {
  it("draws an Ember dot with a halo on the last point only", () => {
    const Dot = latestDot(2);
    const { container } = render(
      <svg>
        <Dot cx={10} cy={20} index={2} />
        <Dot cx={5} cy={5} index={1} />
      </svg>,
    );
    const circles = container.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    expect(circles[0]!.getAttribute("r")).toBe("6");
    expect(circles[0]!.getAttribute("fill-opacity")).toBe("0.2");
    expect(circles[1]!.getAttribute("r")).toBe("3");
  });
});

// H126: on a phone, recharts' touch end doesn't fire onMouseLeave, so the headline and Breakdown
// stayed on the day under the finger after it lifted.
describe("ValueChart", () => {
  it.each(["touchEnd", "touchCancel"] as const)("ends the scrub on %s", (event) => {
    const onScrub = vi.fn();
    const data = [{ ts: 1, snapshot_date: "2026-01-01", v: 1 }];
    const { container } = render(
      <ValueChart data={data} dataKey="v" name="Value" onScrub={onScrub} />,
    );
    fireEvent[event](container.firstElementChild!);
    expect(onScrub).toHaveBeenCalledWith(null);
  });
});
