import { useState } from "react";
import { formatPercent, numberFormat } from "@/lib/locale";
import { formatMoney } from "@/lib/transactions";

export type HeadlineDelta = {
  /** Change over the period, in `currency`. Sign decides the colour. */
  value: number;
  /** Fraction (0.012 = +1.2%). */
  percent?: number;
  /** Plain context ("Month", "YTD"), set in sans muted. */
  label: string;
};

export type HeadlineChange = {
  /** Change over the shown range, in `currency`. Sign picks the arrow. */
  value: number;
  /** Fraction (0.25 = +25%); null when there is no base to divide by. */
  percent: number | null;
  /** Tone classes for the chip (gain, loss or neutral). */
  className: string;
};

// The range change beside the figure, Trade Republic style: a percent with an arrow; a tap
// swaps it to the amount and back. Without a percent it is just the amount.
function ChangeChip({ change, currency }: { change: HeadlineChange; currency: string }) {
  const [asAmount, setAsAmount] = useState(false);
  const arrow = change.value < 0 ? "▼" : "▲";
  const amount = `${arrow} ${formatMoney(Math.abs(change.value), currency)}`;
  const base = `shrink-0 font-figure text-base ${change.className}`;
  if (change.percent == null) return <span className={base}>{amount}</span>;
  return (
    <button
      type="button"
      onClick={() => setAsAmount((v) => !v)}
      aria-label={asAmount ? "Show change as percent" : "Show change as amount"}
      className={`${base} -my-3 rounded-full px-1 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      {asAmount ? amount : `${arrow} ${formatPercent(Math.abs(change.percent), { digits: 2 })}`}
    </button>
  );
}

// A screen's one headline amount, set in bold Geist. Whole units, currency symbol and
// cents share one size; the symbol is muted and the cents sit at 55% so the integer leads.
export function HeadlineFigure({
  value,
  currency,
  delta,
  change,
}: {
  value: number;
  currency: string;
  delta?: HeadlineDelta;
  change?: HeadlineChange | undefined;
}) {
  const parts = numberFormat({
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(value);
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="figure-display min-w-0">
          {parts.map((p, i) =>
            // A real minus, like the signed figures elsewhere (Intl gives a hyphen).
            p.type === "minusSign" ? (
              "−"
            ) : p.type === "currency" ? (
              <span key={i} className="text-muted-foreground">
                {p.value}
              </span>
            ) : p.type === "decimal" || p.type === "fraction" ? (
              // Cents at 55%, wherever the locale puts the symbol (€1,234.56 or 1.234,56 €).
              <span key={i} className="opacity-55">
                {p.value}
              </span>
            ) : (
              p.value
            ),
          )}
        </p>
        {change && <ChangeChip change={change} currency={currency} />}
      </div>
      {delta && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
          <span
            className={`font-figure ${
              delta.value > 0
                ? "text-positive"
                : delta.value < 0
                  ? "text-negative"
                  : "text-foreground"
            }`}
          >
            {delta.value > 0 ? "+" : delta.value < 0 ? "−" : ""}
            {formatMoney(Math.abs(delta.value), currency)}
            {delta.percent != null && ` (${formatPercent(delta.percent, { signed: true })})`}
          </span>
          <span className="text-muted-foreground">{delta.label}</span>
        </p>
      )}
    </div>
  );
}
