import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { PushSubscribeButton } from "@/components/push-subscribe";
import { ChevronRight } from "lucide-react";
import {
  attentionCount,
  groupByBank,
  type HealthItem,
  type HealthRow,
  type HealthState,
} from "@/lib/health";
import { useHealth } from "./use-health";
import { Alert } from "@/components/ui/alert";
import { GroupedList } from "@/components/ui/grouped-list";

const DOT: Record<HealthState, string> = {
  ok: "bg-positive", // green when fine (iOS view board)
  warn: "bg-warning",
  bad: "bg-negative",
};
const STATE_LABEL: Record<HealthState, string> = {
  ok: "Healthy",
  warn: "Needs attention",
  bad: "Broken",
};

function HealthRowItem({ row, onPushed }: { row: HealthRow; onPushed: () => void }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          role="img"
          aria-label={STATE_LABEL[row.state]}
          className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[row.state]}`}
        />
        <div className="min-w-0">
          <p className="text-[0.9375rem] font-medium text-foreground">{row.title}</p>
          <p className="max-w-xl text-sm text-muted-foreground">{row.detail}</p>
        </div>
      </div>
      {row.fix && "push" in row.fix && <PushSubscribeButton onSubscribed={onPushed} />}
      {row.fix && "href" in row.fix && (
        <a
          href={row.fix.href}
          target="_blank"
          rel="noopener noreferrer"
          className="min-h-11 content-center rounded-sm px-3 text-sm font-medium text-primary hover:bg-primary/10"
        >
          {row.fix.label}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      )}
      {row.fix && "to" in row.fix && (
        <Link
          to={row.fix.to}
          className="min-h-11 content-center rounded-sm px-3 text-sm font-medium text-primary hover:bg-primary/10"
        >
          {row.fix.label}
        </Link>
      )}
    </li>
  );
}

// Inside a bank's group the bank name is already on top: "Revolut USD sync" reads "USD sync".
const withoutBank = (row: HealthRow): HealthRow => {
  const rest =
    row.bank && row.title.startsWith(`${row.bank} `) && row.title.slice(row.bank.length + 1);
  return rest ? { ...row, title: rest.charAt(0).toUpperCase() + rest.slice(1) } : row;
};

/** One bank: its worst state and a count; open by default only when something needs a look. */
function BankGroup({
  item,
  onPushed,
}: {
  item: Extract<HealthItem, { rows: unknown }>;
  onPushed: () => void;
}) {
  const attention = attentionCount(item.rows);
  const accounts = item.rows.filter((r) => r.id.startsWith("sync:")).length;
  return (
    <li>
      <details open={attention > 0} className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 py-4 [&::-webkit-details-marker]:hidden">
          <span
            role="img"
            aria-label={STATE_LABEL[item.state]}
            className={`size-2.5 shrink-0 rounded-full ${DOT[item.state]}`}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[0.9375rem] font-medium text-foreground">{item.bank}</span>
            <span className="block text-sm text-muted-foreground">
              {accounts} account{accounts === 1 ? "" : "s"} ·{" "}
              {attention === 0
                ? "all fine"
                : `${attention} need${attention === 1 ? "s" : ""} attention`}
            </span>
          </span>
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
        </summary>
        <ul className="divide-y divide-hairline border-t border-hairline pl-5.5">
          {item.rows.map((row) => (
            <HealthRowItem key={row.id} row={withoutBank(row)} onPushed={onPushed} />
          ))}
        </ul>
      </details>
    </li>
  );
}

function RowList({ items }: { items: Array<HealthItem> }) {
  const queryClient = useQueryClient();
  const onPushed = () => void queryClient.invalidateQueries({ queryKey: ["push-subscribed"] });
  return (
    <GroupedList className="px-5">
      <ul className="divide-y divide-hairline">
        {items.map((item) =>
          "rows" in item ? (
            <BankGroup key={`bank:${item.bank}`} item={item} onPushed={onPushed} />
          ) : (
            <HealthRowItem key={item.id} row={item} onPushed={onPushed} />
          ),
        )}
      </ul>
    </GroupedList>
  );
}

/** Bank access and sync checks, worst first. Push lives under Notifications. */
export function HealthSection() {
  const { accounts, rows } = useHealth();
  const attention = attentionCount(rows);

  return (
    <section id="health" aria-labelledby="health-heading" className="scroll-mt-20 md:scroll-mt-6">
      <h2 id="health-heading" className="text-lg font-semibold text-foreground">
        Health
      </h2>
      {/* Rows run worst first; the count is all the preamble it needs. */}
      <p className="mt-1 mb-4 min-h-5 text-sm font-medium text-foreground">
        {!accounts.isPending &&
          !accounts.isError &&
          `${attention} need${attention === 1 ? "s" : ""} attention.`}
      </p>

      {accounts.isError && (
        <Alert className="mb-4">Couldn't load your accounts: {accounts.error.message}</Alert>
      )}

      {rows.length > 0 && <RowList items={groupByBank(rows)} />}
      {!accounts.isPending && !accounts.isError && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to check yet. Connect a bank first.</p>
      )}
    </section>
  );
}

/**
 * The push enable row and its install hint, on phones only: purchase check-ins are a phone
 * habit, so desktop shows the way to the phone app instead. Renders nothing where push can't work.
 */
export function NotificationsSection() {
  const { push } = useHealth();
  if (!push) return null;
  return (
    <section
      id="notifications"
      aria-labelledby="notifications-heading"
      className="scroll-mt-20 md:hidden"
    >
      <h2 id="notifications-heading" className="mb-4 text-lg font-semibold text-foreground">
        Notifications
      </h2>
      <RowList items={[push]} />
    </section>
  );
}

/** Desktop only: how to get the dashboard on a phone, where notifications live. */
export function GetTheAppSection({ origin = window.location.origin }: { origin?: string }) {
  return (
    <section aria-labelledby="get-app-heading" className="hidden md:block">
      <h2 id="get-app-heading" className="mb-4 text-lg font-semibold text-foreground">
        Get the phone app
      </h2>
      <div className="max-w-xl rounded-lg bg-card px-5 py-4">
        <p className="text-[0.9375rem] text-foreground">
          Open <span className="font-medium">{origin.replace(/^https?:\/\//, "")}</span> on your
          phone and add it to the Home Screen.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          iPhone: Safari → Share → Add to Home Screen. Android: Chrome menu → Install app. Then turn
          on notifications in its Settings to get purchase check-ins.
        </p>
      </div>
    </section>
  );
}
