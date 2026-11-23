import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Measured, MeasuredRow } from "@/lib/trades";
import { summarizeTrades } from "@/lib/trades";
import type { PerformanceRow } from "@/lib/performance";
import {
  PerformanceNotice,
  ReturnCell,
  ReturnDetail,
  ReturnText,
  TradesButton,
  TradesImport,
  resetReturnsView,
} from "./performance-section";

afterEach(resetReturnsView);

const row = (key: string): PerformanceRow => ({
  kind: "stock",
  key,
  name: key,
  quantity: 10,
  start_date: "2026-09-30",
  start_price_eur: 100,
  end_date: "2026-10-30",
  end_price_eur: 120,
  status: "ok",
});
const ok = (gain: number, base: number): Measured => ({
  state: "ok",
  gain,
  base,
  change: gain / base,
});

const trade = {
  id: "1",
  kind: "stock",
  key: "K",
  side: "buy",
  trade_date: "2026-01-01",
  shares: 10,
  price_eur: 90,
  fee_eur: 0,
};

const perf = (rows: Array<MeasuredRow>, over: Record<string, unknown> = {}) =>
  ({
    kind: "stock",
    summary: summarizeTrades(rows),
    measuredByKey: new Map(rows.map((r) => [r.row.key, r.measured])),
    tradesByKey: new Map(
      rows.filter((r) => r.measured.state !== "no_trades").map((r) => [r.row.key, [trade]]),
    ),
    isPending: false,
    unavailable: false,
    error: null,
    ...over,
  }) as unknown as Parameters<typeof PerformanceNotice>[0]["perf"];

const renderWith = (ui: ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe("PerformanceNotice", () => {
  // protects=the Investing hero stays to value + range change (Marco 2026-11-11);
  // fails_when=total return, best/worst or "on N of M holdings" come back under the hero
  it("shows nothing when returns load fine", () => {
    const ranked = [
      { row: row("A"), measured: ok(300, 1000) },
      { row: row("B"), measured: { state: "no_trades" as const } },
    ];
    const { container } = renderWith(
      <PerformanceNotice perf={perf(ranked, { summary: summarizeTrades(ranked, 1) })} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/since purchase|Best|Worst|holdings/)).not.toBeInTheDocument();
  });

  it("shows a load error and the not-yet-migrated note", () => {
    const { unmount } = renderWith(
      <PerformanceNotice perf={perf([], { error: new Error("boom") })} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    unmount();
    renderWith(<PerformanceNotice perf={perf([], { unavailable: true })} />);
    expect(screen.getByText(/latest update/)).toBeInTheDocument();
  });
});

describe("TradesImport", () => {
  it("is always offered once returns load, 44px tall", () => {
    // Always there: a new buy still matches your old share count, so nothing else would prompt it.
    renderWith(<TradesImport perf={perf([{ row: row("A"), measured: ok(200, 1000) }])} />);
    expect(screen.getByRole("button", { name: "Import trades from CSV" })).toHaveClass("min-h-11");
  });

  it("is left out while loading, before the migration, or on a load error", () => {
    for (const over of [{ isPending: true }, { unavailable: true }, { error: new Error("x") }]) {
      const { container, unmount } = renderWith(<TradesImport perf={perf([], over)} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe("ReturnText", () => {
  it("says the same as ReturnCell without being a button", () => {
    renderWith(
      <ReturnText perf={perf([{ row: row("K"), measured: ok(200, 1000) }])} holdingKey="K" />,
    );
    expect(screen.getByText("+20.00%")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks for purchases, or shows a dash with no key or while loading", () => {
    const none = perf([{ row: row("A"), measured: { state: "no_trades" } }]);
    const { unmount } = renderWith(<ReturnText perf={none} holdingKey="A" />);
    expect(screen.getByText("Add purchases")).toBeInTheDocument();
    unmount();
    const { unmount: u2 } = renderWith(<ReturnText perf={none} holdingKey={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    u2();
    renderWith(<ReturnText perf={perf([], { isPending: true })} holdingKey="A" />);
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});

describe("ReturnCell", () => {
  const cell = (measured: Measured, over: Record<string, unknown> = {}) =>
    renderWith(
      <ReturnCell
        perf={perf([{ row: row("K"), measured }], over)}
        holdingKey="K"
        name="Holding"
        quantity={10}
      />,
    );

  it("shows the return, as the way into its trades", () => {
    cell(ok(200, 1000));
    // 44px tall so it's easy to tap on a phone (it was 24px).
    expect(screen.getByRole("button", { name: "+20.00%" })).toHaveClass("min-h-11");
  });

  it("flags a return built on a buy with no price; a priced buy gets no flag", () => {
    const free = { ...trade, price_eur: 0 };
    const view = renderWith(
      <ReturnCell
        perf={perf([{ row: row("K"), measured: ok(200, 1000) }], {
          tradesByKey: new Map([["K", [trade, free]]]),
        })}
        holdingKey="K"
        name="Holding"
        quantity={10}
      />,
    );
    expect(screen.getByRole("button", { name: "+20.00% price missing" })).toBeInTheDocument();
    view.unmount();
    cell(ok(200, 1000));
    expect(screen.queryByText("price missing")).not.toBeInTheDocument();
  });

  it.each([
    ["a figure", ok(200, 1000), "+20.00% price missing"],
    ["—", { state: "ok", gain: 1200, base: 0, change: null } as Measured, "— price missing"],
  ])(
    "polish-5 A-P3-3 when the row shows %s, the trades dialog's price-missing note says so",
    async (_, measured, name) => {
      const free = { ...trade, price_eur: 0 };
      renderWith(
        <ReturnCell
          perf={perf([{ row: row("K"), measured }], {
            tradesByKey: new Map([["K", name.startsWith("—") ? [free] : [trade, free]]]),
          })}
          holdingKey="K"
          name="Holding"
          quantity={10}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name }));
      expect(
        await screen.findByText(
          /^A buy has no price, so the return is too high or can't be worked out\./,
        ),
      ).toBeInTheDocument();
    },
  );

  it("polish-4 R1 puts the price-missing flag on its own small line under the return, so the cell gets no wider", () => {
    const free = { ...trade, price_eur: 0 };
    renderWith(
      <ReturnText
        perf={perf([{ row: row("K"), measured: ok(200, 1000) }], {
          tradesByKey: new Map([["K", [trade, free]]]),
        })}
        holdingKey="K"
      />,
    );
    const flag = screen.getByText("price missing");
    // Stacked: the return on one line, the flag on the next, which never wraps.
    expect(flag.parentElement).toHaveClass("flex-col");
    expect(flag).toHaveClass("text-xs", "text-muted-foreground", "whitespace-nowrap");
    expect(flag.parentElement?.firstElementChild).toHaveTextContent("+20.00%");
  });

  it("asks for purchases when there are none", () => {
    cell({ state: "no_trades" });
    expect(screen.getByText("Add purchases")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("a leftover shows a dash and asks for nothing", () => {
    cell({ state: "dust" });
    expect(screen.queryByText("Add purchases")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "—" })).toBeInTheDocument();
  });

  it("says when trades don't match, with no number", () => {
    cell({ state: "mismatch", traded: 8, held: 10 });
    expect(screen.getByText("Trades don't match")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("doesn't ask for purchases you may already have when loading them failed", () => {
    cell({ state: "no_trades" }, { error: new Error("boom") });
    expect(screen.queryByText("Add purchases")).not.toBeInTheDocument();
  });

  it("doesn't claim anything while loading", () => {
    cell({ state: "no_trades" }, { isPending: true });
    expect(screen.queryByText("Add purchases")).not.toBeInTheDocument();
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});

describe("ReturnDetail", () => {
  const detail = (measured: Measured, over: Record<string, unknown> = {}) =>
    renderWith(
      <ReturnDetail
        perf={perf([{ row: row("K"), measured }], over)}
        holdingKey="K"
        name="Holding"
        quantity={10}
      />,
    );

  // protects=Marco 2026-11-23: a holding's return amount was shown nowhere; tap swaps % and €
  // like the Net worth change; fails_when=the tap opens trades again or shows no amount
  it("shows the return in bold; a tap swaps it to the amount and back", () => {
    detail(ok(200, 1000));
    const toggle = screen.getByRole("button", { name: /\+20\.00%\. Show as amount/ });
    expect(toggle).toHaveTextContent("+20.00%");
    expect(toggle).toHaveClass("font-semibold", "font-figure", "text-positive", "min-h-11");
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("+€200.00");
    expect(toggle).toHaveAccessibleName(/Show as percent/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("+20.00%");
  });

  // protects=Marco 2026-11-23 "on phone as well": the closed phone row and every other holding
  // follow one tap; fails_when=each return keeps its own % / € choice
  it("one tap switches every return on the page, closed phone rows too", () => {
    const p = perf([
      { row: row("K"), measured: ok(200, 1000) },
      { row: row("L"), measured: ok(-30, 600) },
    ]);
    renderWith(
      <>
        <ReturnDetail perf={p} holdingKey="K" name="K" quantity={10} />
        <ReturnDetail perf={p} holdingKey="L" name="L" quantity={10} />
        <ReturnText perf={p} holdingKey="L" />
      </>,
    );
    expect(screen.getAllByText("−5.00%")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /\+20\.00%/ }));
    expect(screen.getByRole("button", { name: /\+€200\.00/ })).toBeInTheDocument();
    expect(screen.getAllByText("−€30.00")).toHaveLength(2);
    expect(screen.getAllByText("−€30.00")[1]).toHaveClass("text-negative");
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("a closed row with a flagged return keeps its percent and flag in amount mode", () => {
    const free = { ...trade, price_eur: 0 };
    const p = perf([{ row: row("K"), measured: ok(200, 1000) }], {
      tradesByKey: new Map([["K", [trade, free]]]),
    });
    const clean = perf([{ row: row("M"), measured: ok(10, 100) }]);
    renderWith(
      <>
        <ReturnDetail perf={clean} holdingKey="M" name="M" quantity={1} />
        <ReturnText perf={p} holdingKey="K" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Show as amount/ }));
    expect(screen.getByText("price missing")).toBeInTheDocument();
    expect(screen.getByText("+20.00%")).toBeInTheDocument();
  });

  it("a loss reads with a real minus, in the loss colour", () => {
    detail(ok(-50, 1000));
    const toggle = screen.getByRole("button", { name: /Show as amount/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveTextContent("−€50.00");
    expect(toggle).toHaveClass("text-negative");
  });

  it("with no base to divide by, shows the amount alone, not a button", () => {
    detail({ state: "ok", gain: 30, base: 0, change: null });
    expect(screen.getByText("+€30.00")).toHaveClass("font-semibold");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("anything but a clean return stays the way into the trades", () => {
    const view = detail({ state: "no_trades" });
    expect(screen.getByRole("button", { name: "Add purchases" })).toBeInTheDocument();
    view.unmount();
    renderWith(
      <ReturnDetail
        perf={perf([{ row: row("K"), measured: ok(200, 1000) }], {
          tradesByKey: new Map([["K", [trade, { ...trade, price_eur: 0 }]]]),
        })}
        holdingKey="K"
        name="Holding"
        quantity={10}
      />,
    );
    expect(screen.getByRole("button", { name: "+20.00% price missing" })).toBeInTheDocument();
  });

  it("doesn't claim anything while loading", () => {
    detail(ok(200, 1000), { isPending: true });
    expect(screen.getByText("…")).toBeInTheDocument();
  });
});

describe("TradesButton", () => {
  const button = (
    measured: Measured,
    over: Record<string, unknown> = {},
    key: string | null = "K",
  ) =>
    renderWith(
      <TradesButton
        perf={perf([{ row: row("K"), measured }], over)}
        holdingKey={key}
        name="Holding"
        quantity={10}
      />,
    );

  it("as an icon (desktop row), still says what it opens", () => {
    renderWith(
      <TradesButton
        perf={perf([{ row: row("K"), measured: ok(200, 1000) }])}
        holdingKey="K"
        name="Holding"
        quantity={10}
        iconOnly
      />,
    );
    expect(screen.getByRole("button", { name: "Trades for Holding" })).toHaveClass("size-11");
  });

  it("opens the trades once the return toggles instead", async () => {
    button(ok(200, 1000));
    fireEvent.click(screen.getByRole("button", { name: "Trades" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it.each([
    ["no trades", { state: "no_trades" } as Measured, {}, "K"],
    ["a mismatch", { state: "mismatch", traded: 8, held: 10 } as Measured, {}, "K"],
    [
      "a missing price",
      ok(200, 1000),
      { tradesByKey: new Map([["K", [{ ...trade, price_eur: 0 }]]]) },
      "K",
    ],
    ["while loading", ok(200, 1000), { isPending: true }, "K"],
    ["no key", ok(200, 1000), {}, null],
  ])("is left out with %s (the return opens them, or there is nothing yet)", (_, m, over, key) => {
    const { container } = button(m, over, key);
    expect(container).toBeEmptyDOMElement();
  });
});
