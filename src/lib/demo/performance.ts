import type { PerformanceRow } from "@/lib/performance";

// The demo's stand-in for the database function holding_performance. Returns come from trades
// (lib/trades), which read each holding's quantity and latest price; the range chip and the Return
// line also read the price on `from`. EUR uses each snapshot's own rate.
type Row = Record<string, unknown>;
type Point = { date: string; eur: number };

function toRow(
  kind: string,
  key: string,
  name: string | null,
  quantity: number,
  points: Array<Point>,
  from: string | undefined,
): PerformanceRow {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const end = sorted.at(-1);
  // As the database: the last price on or before `from`, else the first there is.
  const before = from == null ? undefined : sorted.filter((p) => p.date <= from).at(-1);
  const start = from == null ? undefined : (before ?? sorted[0]);
  return {
    kind,
    key,
    name,
    quantity,
    start_date: start?.date ?? null,
    start_price_eur: start?.eur ?? null,
    end_date: end?.date ?? null,
    end_price_eur: end?.eur ?? null,
    status: !end ? "no_price" : start && !before ? "since" : "ok",
  };
}

export function demoHoldingPerformance(
  db: Record<string, Array<Row>>,
  from?: string,
): Array<PerformanceRow> {
  const stocks = (db["portfolio_holdings"] ?? [])
    .filter((h) => (h["shares"] as number) > 0)
    .map((h) => {
      const points = (db["portfolio_snapshots"] ?? [])
        .filter((s) => s["isin"] === h["isin"] && (s["value_native"] as number) > 0)
        .map((s) => ({
          date: s["snapshot_date"] as string,
          eur:
            (s["price"] as number) * ((s["value_eur"] as number) / (s["value_native"] as number)),
        }));
      return toRow(
        "stock",
        h["isin"] as string,
        h["name"] as string,
        h["shares"] as number,
        points,
        from,
      );
    });
  const symbols = [
    ...new Set((db["crypto_holdings"] ?? []).map((c) => c["asset_symbol"] as string)),
  ];
  const coins = symbols.flatMap((symbol) => {
    const held = (db["crypto_holdings"] ?? []).filter((c) => c["asset_symbol"] === symbol);
    const amount = held.reduce((s, c) => s + (c["amount"] as number), 0);
    if (amount <= 0) return [];
    const points = (db["crypto_snapshots"] ?? [])
      .filter((s) => s["asset_symbol"] === symbol && (s["value_usd"] as number) > 0)
      .map((s) => ({
        date: s["snapshot_date"] as string,
        eur: (s["price_usd"] as number) * ((s["value_eur"] as number) / (s["value_usd"] as number)),
      }));
    return [toRow("crypto", symbol, held[0]!["name"] as string, amount, points, from)];
  });
  return [...stocks, ...coins];
}
