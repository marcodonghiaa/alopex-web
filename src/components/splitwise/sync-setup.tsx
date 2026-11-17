import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, RefreshCw, Trash2, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { GroupedList } from "@/components/ui/grouped-list";
import { isDemoMode } from "@/lib/demo/mode";
import { cn } from "@/lib/utils";
import { useSplitwiseConnection, useSyncNow, useSyncRunning } from "@/lib/use-splitwise-sync";
import {
  disconnectSplitwise,
  formatCount,
  syncedAgo,
  syncRefreshKeys,
  type SplitwiseConnection,
} from "@/lib/splitwise-sync";
import { PENDING } from "./pending";
import { ConnectDialog } from "./connect-dialog";

/** Focuses the setup's main control (Sync now, Reconnect, Connect or Retry) if focus was lost. */
const focusPrimary = () =>
  requestAnimationFrame(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    document.querySelector<HTMLElement>("[data-splitwise-primary]")?.focus();
  });

const ROW =
  "flex min-h-11 w-full items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 sm:px-5";

/**
 * Setup for Splitwise, after the balances: a quiet Connect row (like Connect a bank on Accounts)
 * or, once connected, the sync's status with Sync now and Disconnect. The CSV import stays (the
 * backend skips the shares the sync already has, so a file never doubles them).
 */
export function SyncSetup({ onImportFile }: { onImportFile: () => void }) {
  const connection = useSplitwiseConnection();
  // Fixed when the dialog opens: connecting flips the status to connected under it.
  const [connecting, setConnecting] = useState<"connect" | "reconnect" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const c = connection.data;
  const connected = c?.connected === true;
  // When the row that had focus is replaced (connected, disconnected, data deleted, Retry worked),
  // focus goes to the setup's new main control, not to <body>. Loading the page moves nothing.
  const stateKey = connection.isPending
    ? null
    : `${connected}|${connection.isError}|${c?.syncedData}`;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (stateKey === null) return;
    if (lastKey.current !== null && lastKey.current !== stateKey) focusPrimary();
    lastKey.current = stateKey;
  }, [stateKey]);

  return (
    <>
      <GroupedList className="mt-3">
        {connection.isError ? (
          <div className="px-4 py-3 sm:px-5">
            <Alert>Couldn't load the Splitwise connection: {connection.error.message}</Alert>
            <Button
              variant="secondary"
              className="mt-2"
              data-splitwise-primary
              onClick={() => void connection.refetch()}
              disabled={connection.isFetching}
            >
              Retry
            </Button>
          </div>
        ) : connected ? (
          <StatusRow
            c={c}
            onReconnect={() => setConnecting("reconnect")}
            onDisconnect={() => setDisconnecting(true)}
          />
        ) : (
          !connection.isPending && (
            <>
              {c?.syncedData && (
                <p className="px-4 pt-3 text-[0.8125rem] text-muted-foreground sm:px-5">
                  Disconnected. What was synced stays; nothing new comes in.
                </p>
              )}
              <button
                type="button"
                data-splitwise-primary
                onClick={() => setConnecting("connect")}
                className={ROW}
              >
                <Link2 aria-hidden className="size-4" />
                Connect Splitwise
              </button>
            </>
          )
        )}
        {!connected && c?.syncedData && (
          <button
            type="button"
            onClick={() => setDeleting(true)}
            className={cn(ROW, "text-negative disabled:opacity-50")}
            disabled={isDemoMode()}
          >
            <Trash2 aria-hidden className="size-4" />
            Delete synced Splitwise data
          </button>
        )}
        <div>
          <button
            type="button"
            onClick={onImportFile}
            className={ROW}
            aria-describedby={connected ? "splitwise-file-while-synced" : undefined}
          >
            <Upload aria-hidden className="size-4" />
            Import a file instead
          </button>
          {connected && (
            <p
              id="splitwise-file-while-synced"
              className="px-4 pb-3 text-xs text-muted-foreground sm:px-5"
            >
              Expenses the sync already brought in are skipped, so only what it can't see is added.
            </p>
          )}
        </div>
      </GroupedList>
      <ConnectDialog
        open={connecting !== null}
        onOpenChange={(open) => open || setConnecting(null)}
        onCloseAutoFocus={focusPrimary}
        reconnect={connecting === "reconnect"}
      />
      <DisconnectDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        onCloseAutoFocus={focusPrimary}
      />
      <DisconnectDialog
        open={deleting}
        onOpenChange={setDeleting}
        onCloseAutoFocus={focusPrimary}
        mode="delete"
      />
    </>
  );
}

function StatusRow({
  c,
  onReconnect,
  onDisconnect,
}: {
  c: SplitwiseConnection;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const sync = useSyncNow();
  const syncing = useSyncRunning();
  const demo = isDemoMode();
  const reconnect = c.status === "needs_reconnect";
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          aria-hidden
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted"
        >
          <RefreshCw className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.9375rem] font-medium">
            Splitwise{c.displayName ? ` · ${c.displayName}` : ""}
          </p>
          <p className="text-[0.8125rem] text-muted-foreground">{syncedAgo(c.lastSyncedAt)}</p>
        </div>
        {reconnect ? (
          <Button data-splitwise-primary onClick={onReconnect} disabled={demo}>
            Reconnect
          </Button>
        ) : (
          <Button
            variant="secondary"
            className={PENDING}
            data-splitwise-primary
            onClick={() => sync()}
            disabled={demo}
            aria-disabled={syncing || undefined}
          >
            {syncing ? "Syncing…" : "Sync now"}
          </Button>
        )}
      </div>
      {reconnect && (
        <p role="status" className="mt-2 flex items-start gap-2 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          Splitwise no longer accepts the key. Reconnect with a new one to keep syncing.
        </p>
      )}
      {c.status === "error" && (
        <p role="status" className="mt-2 flex items-start gap-2 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          Last sync failed: {c.lastError ?? "unknown error"}
        </p>
      )}
      {demo && (
        <p role="note" className="mt-2 text-sm text-muted-foreground">
          Splitwise sync is off in the demo.
        </p>
      )}
      <Button variant="destructive" className="-ml-4 mt-1" onClick={onDisconnect} disabled={demo}>
        Disconnect
      </Button>
    </div>
  );
}

const DELETE_DETAIL =
  "Removes synced expenses, the To link list and Splitwise balances, and frees the bank payments they changed.";

/**
 * Disconnect deletes the key; the user chooses whether what was synced goes too. In "delete" mode
 * (already disconnected, data kept) it only deletes what was synced, once confirmed.
 */
function DisconnectDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  mode = "disconnect",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: () => void;
  mode?: "disconnect" | "delete";
}) {
  const queryClient = useQueryClient();
  const onlyDelete = mode === "delete";
  const [deleteData, setDeleteData] = useState(false);
  useEffect(() => {
    if (open) setDeleteData(false); // keeping is the default every time
  }, [open]);
  // Set in the click itself: isPending only shows on the next render, after a second click.
  const running = useRef(false);
  const disconnect = useMutation({
    // The choice travels with the call: the dialog may reset it before the answer comes.
    mutationFn: (andData: boolean) => disconnectSplitwise(andData),
    onSettled: () => (running.current = false),
    onSuccess: ({ deleted }, andData) => {
      toast.success(
        onlyDelete
          ? `Synced Splitwise data deleted: ${deleted === 1 ? "1 expense" : `${formatCount(deleted)} expenses`}`
          : andData
            ? `Splitwise disconnected, ${deleted === 1 ? "1 synced expense" : `${formatCount(deleted)} synced expenses`} removed`
            : "Splitwise disconnected. What was synced stays.",
      );
      for (const queryKey of syncRefreshKeys()) void queryClient.invalidateQueries({ queryKey });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const options: Array<[boolean, string, string]> = [
    [false, "Keep synced data", "Expenses and balances synced so far stay. Nothing new comes in."],
    [true, "Delete synced data", DELETE_DETAIL],
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => disconnect.isPending || onOpenChange(next)}>
      <DialogContent className="gap-0 rounded-xl p-5 sm:p-6" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle className="text-xl font-semibold tracking-tight">
          {onlyDelete ? "Delete synced Splitwise data?" : "Disconnect Splitwise?"}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {onlyDelete
            ? DELETE_DETAIL
            : "Alopex deletes your API key from your server and stops syncing."}
        </DialogDescription>
        {!onlyDelete && (
          <fieldset className="mt-5 divide-y divide-hairline overflow-hidden rounded-lg bg-card">
            <legend className="sr-only">What was synced</legend>
            {options.map(([value, label, detail]) => (
              <label
                key={label}
                className="flex cursor-pointer items-start gap-3 px-4 py-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-inset"
              >
                <input
                  type="radio"
                  name="splitwise-disconnect"
                  checked={deleteData === value}
                  onChange={() => setDeleteData(value)}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-medium">{label}</span>
                  <span className="block text-[0.8125rem] text-muted-foreground">{detail}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="quiet"
            onClick={() => onOpenChange(false)}
            disabled={disconnect.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className={PENDING}
            onClick={() => {
              if (running.current) return;
              running.current = true;
              disconnect.mutate(onlyDelete || deleteData);
            }}
            aria-disabled={disconnect.isPending || undefined}
          >
            {onlyDelete
              ? disconnect.isPending
                ? "Deleting…"
                : "Delete"
              : disconnect.isPending
                ? "Disconnecting…"
                : "Disconnect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
