import { TradesDialog, hasMissingPrice } from "@/components/holdings/trades-dialog";
import { useState } from "react";
import { ListOrdered, TriangleAlert } from "lucide-react";
import { ImportTrades } from "@/components/holdings/import-trades";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { RETURN_NOISE_BAND, formatReturn } from "@/lib/performance";
import type { usePerformance } from "@/lib/use-performance";
import type { Measured } from "@/lib/trades";
import { formatMoney } from "@/lib/transactions";
import { TONE_TEXT, toneOf } from "@/lib/tone";

type Performance = ReturnType<typeof usePerformance>;

function Change({ change }: { change: number | null }) {
  if (change == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={`font-figure ${TONE_TEXT[toneOf(change, RETURN_NOISE_BAND)]}`}>
      {formatReturn(change)}
    </span>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

/** What a holding's return cell says: its return, or what's stopping it. */
function returnLabel(perf: Performance, holdingKey: string) {
  const measured = perf.measuredByKey.get(holdingKey);
  const trades = perf.tradesByKey.get(holdingKey) ?? [];
  if (measured?.state === "dust") return dash;
  if (trades.length === 0) return <span className="text-xs text-primary">Add purchases</span>;
  if (measured?.state === "ok" && hasMissingPrice(trades)) {
    // The €0 buy makes the return look better than it is: say so under it, so the cell stays narrow.
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <Change change={measured.change} />{" "}
        <span className="inline-flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
          <TriangleAlert aria-hidden className="size-3 self-center text-warning" />
          price missing
        </span>
      </span>
    );
  }
  if (measured?.state === "ok") return <Change change={measured.change} />;
  if (measured?.state === "mismatch") {
    return <span className="text-xs text-negative">Trades don't match</span>;
  }
  return dash;
}

/** The same words as ReturnCell, not tappable: for a row whose own tap expands it. */
export function ReturnText({ perf, holdingKey }: { perf: Performance; holdingKey: string | null }) {
  if (perf.isPending) return <span className="text-muted-foreground">…</span>;
  if (perf.unavailable || perf.error || holdingKey == null) return dash;
  return returnLabel(perf, holdingKey);
}

/** A holding's total return, or what's stopping it. Tapping it opens its trades. */
export function ReturnCell({
  perf,
  holdingKey,
  name,
  quantity,
}: {
  perf: Performance;
  holdingKey: string | null;
  name: string;
  quantity: number;
}) {
  if (perf.isPending || perf.unavailable || perf.error || holdingKey == null) {
    return <ReturnText perf={perf} holdingKey={holdingKey} />;
  }
  // Always the same trigger, so adding the first trade keeps the dialog open.
  return (
    <TradesDialog
      kind={perf.kind}
      holdingKey={holdingKey}
      name={name}
      quantity={quantity}
      trades={perf.tradesByKey.get(holdingKey) ?? []}
      label={returnLabel(perf, holdingKey)}
    />
  );
}

type Measurable = { perf: Performance; holdingKey: string | null; name: string; quantity: number };

/** A clean return (trades match, every buy priced): the one a tap can turn into an amount. */
function cleanReturn(perf: Performance, holdingKey: string | null) {
  if (perf.isPending || perf.unavailable || perf.error || holdingKey == null) return null;
  const measured = perf.measuredByKey.get(holdingKey);
  if (measured?.state !== "ok" || hasMissingPrice(perf.tradesByKey.get(holdingKey) ?? [])) {
    return null;
  }
  return measured as Extract<Measured, { state: "ok" }>;
}

/** "+€1,234.56" / "−€12.00": signed, with a real minus. */
const signedEur = (value: number) =>
  `${value < 0 ? "−" : "+"}${formatMoney(Math.abs(value), "EUR")}`;

/** A holding's return in its open detail, in bold. A tap swaps percent and amount, like the
 * Net worth change; the trades open from TradesButton below. Anything else stays ReturnCell. */
export function ReturnDetail(props: Measurable) {
  const [asAmount, setAsAmount] = useState(false);
  const measured = cleanReturn(props.perf, props.holdingKey);
  if (!measured) return <ReturnCell {...props} />;
  const { change, gain } = measured;
  const base = `font-figure font-semibold ${TONE_TEXT[toneOf(change ?? gain, RETURN_NOISE_BAND)]}`;
  // No base to divide by (sold out and back in at nothing): the amount is all there is.
  if (change == null) return <span className={base}>{signedEur(gain)}</span>;
  const shown = asAmount ? signedEur(gain) : formatReturn(change);
  return (
    <button
      type="button"
      onClick={() => setAsAmount((v) => !v)}
      aria-label={`Return ${shown}. Show as ${asAmount ? "percent" : "amount"}`}
      className={`${base} -my-2.5 inline-flex min-h-11 items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
    >
      {shown}
    </button>
  );
}

/** "Trades" at the foot of a holding's detail, since its return now toggles instead. Left out
 * when the return itself still opens them (no trades, a mismatch, a missing price). */
export function TradesButton({ perf, holdingKey, name, quantity }: Measurable) {
  if (holdingKey == null || !cleanReturn(perf, holdingKey)) return null;
  return (
    <TradesDialog
      kind={perf.kind}
      holdingKey={holdingKey}
      name={name}
      quantity={quantity}
      trades={perf.tradesByKey.get(holdingKey) ?? []}
      label={
        <>
          <ListOrdered />
          Trades
        </>
      }
      triggerClassName={buttonVariants({ variant: "ghost", className: "-ml-3 self-start" })}
    />
  );
}

/** Only what needs saying under the hero: returns failed to load, or the database needs its
 * update. The range change above answers "how did it move"; returns live on each row. */
export function PerformanceNotice({ perf }: { perf: Performance }) {
  if (perf.error) {
    return <Alert className="mt-3">Couldn't load returns: {perf.error.message}</Alert>;
  }
  if (perf.unavailable) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        Returns appear once your database has the latest update (see UPGRADING.md).
      </p>
    );
  }
  return null;
}

/** "Import trades from CSV", under the holdings it fills in. Always offered once returns load: a new
 * buy still matches your old share count, so nothing else would prompt it. */
export function TradesImport({ perf }: { perf: Performance }) {
  if (perf.isPending || perf.unavailable || perf.error) return null;
  return (
    <p className="mt-3 px-1">
      <ImportTrades kind={perf.kind} saved={[...perf.tradesByKey.values()].flat()} />
    </p>
  );
}
