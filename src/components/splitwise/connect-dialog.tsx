import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { GroupedList } from "@/components/ui/grouped-list";
import { isDemoMode } from "@/lib/demo/mode";
import {
  CONNECTION_KEY,
  connectSplitwise,
  formatCount,
  previewSync,
  type SyncCounts,
} from "@/lib/splitwise-sync";
import { useSyncNow, useSyncRunning } from "@/lib/use-splitwise-sync";

const CONSENT_TEXT =
  "Alopex reads your Splitwise expenses and stores the key encrypted on your own server; disconnect anytime";

const COUNTS: Array<[keyof SyncCounts, string]> = [
  ["new", "New expenses"],
  ["adopted", "Already imported"],
  ["review", "To link"],
  ["deleted", "Removed"],
];

/**
 * Connect (or reconnect) Splitwise: three steps to get the personal API key, the key, consent.
 * Once connected, a dry run says what the first sync will bring in before it starts.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  reconnect = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reconnect?: boolean;
}) {
  const queryClient = useQueryClient();
  const keyId = useId();
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  // A new dry run for every connect, even with the same account.
  const [connectedAt, setConnectedAt] = useState(0);
  const demo = isDemoMode();

  useEffect(() => {
    if (open) return;
    setApiKey("");
    setConsent(false);
    setProblem(null);
    setName(null);
  }, [open]);

  const connect = useMutation({
    mutationFn: () => connectSplitwise(apiKey),
    onSuccess: ({ displayName }) => {
      setApiKey(""); // the key is on the server now; nothing keeps it in the page
      setName(displayName);
      setConnectedAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: CONNECTION_KEY });
    },
    onError: (err) => setProblem(err.message),
  });
  const preview = useQuery({
    queryKey: ["splitwise-preview", connectedAt],
    queryFn: previewSync,
    enabled: name !== null,
    retry: false,
    staleTime: Infinity,
  });
  const start = useSyncNow(() => onOpenChange(false));
  const syncing = useSyncRunning();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (apiKey.trim() === "") return setProblem("Paste your Splitwise API key first.");
    if (!consent) return setProblem("Tick the box to let Alopex read your Splitwise expenses.");
    setProblem(null);
    connect.mutate();
  };

  const title = reconnect ? "Reconnect Splitwise" : "Connect Splitwise";
  return (
    <Dialog open={open} onOpenChange={(next) => connect.isPending || onOpenChange(next)}>
      <DialogContent className="gap-0 rounded-xl p-5 sm:p-6">
        <DialogTitle className="text-xl font-semibold tracking-tight">{title}</DialogTitle>
        {name === null ? (
          <form onSubmit={submit} noValidate>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              Your Splitwise expenses come in by themselves, every 6 hours and on Sync now.
            </DialogDescription>
            {demo && (
              <p role="note" className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">
                Splitwise sync is off in the demo. Look around: Connect won't send anything.
              </p>
            )}
            <ol className="mt-5 space-y-3 text-sm">
              {[
                <>
                  Open{" "}
                  <a
                    href="https://secure.splitwise.com/apps"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                  >
                    secure.splitwise.com/apps <span aria-hidden="true">↗</span>
                    <span className="sr-only">(opens in new tab)</span>
                  </a>{" "}
                  and sign in.
                </>,
                <>Choose Register your application. Any name works; the URLs don't matter.</>,
                <>Copy the API key and paste it below.</>,
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span aria-hidden className="w-4 shrink-0 font-figure text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0">{step}</span>
                </li>
              ))}
            </ol>
            <label htmlFor={keyId} className="mt-5 mb-1 block text-xs text-muted-foreground">
              API key
            </label>
            <Input
              id={keyId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="font-figure"
            />
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <span>{CONSENT_TEXT}</span>
            </label>
            {problem && (
              <p role="alert" className="mt-4 text-sm text-negative">
                {problem}
              </p>
            )}
            <Button type="submit" className="mt-5 w-full" disabled={demo || connect.isPending}>
              {connect.isPending ? "Checking the key…" : "Connect"}
            </Button>
          </form>
        ) : (
          <div>
            <DialogDescription className="mt-2 flex items-center gap-2 text-[0.9375rem] text-foreground">
              <Check aria-hidden className="size-4" />
              Connected as {name}
            </DialogDescription>
            <p className="mt-4 text-sm text-muted-foreground">The first sync brings in:</p>
            {preview.isPending ? (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                Checking what Splitwise has…
              </p>
            ) : preview.isError ? (
              <Alert className="mt-2">{preview.error.message}</Alert>
            ) : (
              <GroupedList className="mt-2 bg-background">
                <dl className="divide-y divide-hairline">
                  {COUNTS.map(([k, label]) => (
                    <div key={k} className="flex min-h-11 items-center justify-between px-4">
                      <dt className="text-sm">{label}</dt>
                      <dd className="font-figure text-[0.9375rem]">
                        {formatCount(preview.data[k])}
                      </dd>
                    </div>
                  ))}
                </dl>
              </GroupedList>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Already imported: shares from a Splitwise file, kept, not doubled. To link: expenses
              you paid and settle-ups, to match with a bank payment.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Later
              </Button>
              <Button onClick={() => start.mutate()} disabled={syncing}>
                {syncing ? "Syncing…" : "Start sync"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
