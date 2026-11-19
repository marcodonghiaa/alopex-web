import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { GroupedList } from "@/components/ui/grouped-list";
import { isDemoMode } from "@/lib/demo/mode";
import { cn } from "@/lib/utils";
import { PENDING } from "./pending";
import {
  CONNECTION_KEY,
  connectSplitwise,
  formatCount,
  previewSync,
  SyncError,
  type SyncCounts,
} from "@/lib/splitwise-sync";
import { useSyncNow, useSyncRunning } from "@/lib/use-splitwise-sync";

const CONSENT_TEXT =
  "Alopex reads your Splitwise expenses and stores the key encrypted on your own server; disconnect anytime.";

// Each label explains itself; rows with nothing in them are hidden.
const COUNTS: Array<[keyof SyncCounts, string]> = [
  ["new", "New expenses"],
  ["adopted", "Already imported (kept, not doubled)"],
  ["review", "To link with a bank payment"],
  ["deleted", "Removed in Splitwise"],
];

/**
 * Connect (or reconnect) Splitwise: Splitwise only gives API keys to Splitwise Pro accounts, so it
 * says that first and offers the file import instead. Then three steps to get the personal API key, the key, consent.
 * Once connected, a dry run says what the next sync will bring in before it starts.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onImportFile,
  reconnect = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After close: the opener may be gone (connecting replaces the Connect row). */
  onCloseAutoFocus?: () => void;
  /** The CSV import: the way in without Splitwise Pro. */
  onImportFile: () => void;
  reconnect?: boolean;
}) {
  const queryClient = useQueryClient();
  const keyId = useId();
  const [apiKey, setApiKey] = useState("");
  const [consent, setConsent] = useState(false);
  // Which field the problem is about: it is described by the alert and gets focus.
  // `refused`: Splitwise said no to the key (or wants Splitwise Pro), so the file import is offered.
  const [problem, setProblem] = useState<{
    text: string;
    on: "key" | "consent";
    refused?: boolean;
  } | null>(null);
  const problemId = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const invalid = (on: "key" | "consent") =>
    problem?.on === on ? { "aria-invalid": true, "aria-describedby": problemId } : {};
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
    onError: (err) => {
      setProblem({
        text: err.message,
        on: "key",
        refused: err instanceof SyncError && err.status === 400,
      });
      keyRef.current?.focus();
    },
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
    if (connect.isPending) return;
    if (apiKey.trim() === "") {
      setProblem({ text: "Paste your Splitwise API key first.", on: "key" });
      return keyRef.current?.focus();
    }
    if (!consent) {
      setProblem({
        text: "Tick the box to let Alopex read your Splitwise expenses.",
        on: "consent",
      });
      return consentRef.current?.focus();
    }
    setProblem(null);
    connect.mutate();
  };

  const importFile = () => {
    onOpenChange(false);
    onImportFile();
  };
  const title = reconnect ? "Reconnect Splitwise" : "Connect Splitwise";
  return (
    <Dialog open={open} onOpenChange={(next) => connect.isPending || onOpenChange(next)}>
      <DialogContent
        className="gap-0 rounded-xl p-5 sm:p-6"
        onCloseAutoFocus={onCloseAutoFocus}
        closeDisabled={connect.isPending}
      >
        <DialogTitle className="text-xl font-semibold tracking-tight">{title}</DialogTitle>
        {name === null ? (
          <form onSubmit={submit} noValidate>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              Your Splitwise expenses come in by themselves, every 6 hours and on Sync now.
            </DialogDescription>
            <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">
              Needs a Splitwise Pro subscription (Splitwise requires it for API keys). No Pro?{" "}
              <button
                type="button"
                onClick={importFile}
                className="font-medium text-primary underline underline-offset-2"
              >
                Import a Splitwise file instead
              </button>
              .
            </p>
            {demo && (
              <p role="note" className="mt-4 rounded-md bg-muted px-3 py-2 text-sm">
                Splitwise sync is off in the demo. Look around: Connect won't send anything.
              </p>
            )}
            <ol className="mt-5 list-decimal space-y-3 pl-5 text-sm marker:text-muted-foreground">
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
                <li key={i} className="pl-1">
                  {step}
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
              ref={keyRef}
              {...invalid("key")}
              onChange={(e) => {
                setApiKey(e.target.value);
                setProblem(null);
              }}
              // On the dialog's background the default fill and border vanish (1.48:1).
              className="bg-card font-figure"
            />
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                ref={consentRef}
                {...invalid("consent")}
                onChange={(e) => {
                  setConsent(e.target.checked);
                  setProblem(null);
                }}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <span>{CONSENT_TEXT}</span>
            </label>
            {problem && (
              <p id={problemId} role="alert" className="mt-4 text-sm text-negative">
                {problem.text}
              </p>
            )}
            {problem?.refused && (
              <Button variant="quiet" className="mt-2 w-full" onClick={importFile}>
                Import a file instead
              </Button>
            )}
            <Button
              type="submit"
              className={cn("mt-5 w-full", PENDING)}
              disabled={demo}
              aria-disabled={connect.isPending || undefined}
            >
              {connect.isPending ? "Checking the key…" : "Connect"}
            </Button>
          </form>
        ) : (
          <div>
            <DialogDescription className="mt-2 flex items-center gap-2 text-[0.9375rem] text-foreground">
              <Check aria-hidden className="size-4" />
              Connected as {name}
            </DialogDescription>
            <p className="mt-4 text-sm text-muted-foreground">
              {reconnect ? "The next sync brings in:" : "The first sync brings in:"}
            </p>
            {preview.isPending ? (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                Checking what Splitwise has…
              </p>
            ) : preview.isError ? (
              <Alert className="mt-2">{preview.error.message}</Alert>
            ) : COUNTS.every(([k]) => preview.data[k] === 0) ? (
              <p className="mt-2 text-sm">Nothing new to bring in.</p>
            ) : (
              <>
                <GroupedList className="mt-2">
                  <dl className="divide-y divide-hairline">
                    {COUNTS.filter(([k]) => preview.data[k] > 0).map(([k, label]) => (
                      <div key={k} className="flex min-h-11 items-center justify-between px-4">
                        <dt className="text-sm">{label}</dt>
                        <dd className="font-figure text-[0.9375rem]">
                          {formatCount(preview.data[k])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </GroupedList>
                {preview.data.new > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    New expenses add your share to your spending, no review needed.
                  </p>
                )}
              </>
            )}
            {/* Already connected: closing doesn't stop the sync. */}
            <p className="mt-4 text-xs text-muted-foreground">
              Syncs automatically within 6 hours.
            </p>
            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="quiet" onClick={() => onOpenChange(false)}>
                Not now
              </Button>
              <Button
                className={PENDING}
                onClick={() => start()}
                aria-disabled={syncing || undefined}
              >
                {syncing ? "Syncing…" : "Start sync"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
