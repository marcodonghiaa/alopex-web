import {
  keepPreviousData,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { fetchBankWindow } from "@/lib/import/splitwise-bank";
import { makeRate } from "@/lib/fx";
import {
  CONNECTION_KEY,
  fetchConnection,
  fetchReview,
  REVIEW_KEY,
  suggestMatches,
  syncNow,
  syncRefreshKeys,
  syncSummary,
  SyncError,
} from "@/lib/splitwise-sync";

/** The user's Splitwise connection. A backend without the sync reads as not connected. */
export function useSplitwiseConnection() {
  return useQuery({ queryKey: CONNECTION_KEY, queryFn: fetchConnection, staleTime: 30_000 });
}

const SYNC_NOW_KEY = ["splitwise-sync-now"];

/** A sync is running, started from any button (the connect dialog's or the status row's). */
export const useSyncRunning = () => useIsMutating({ mutationKey: SYNC_NOW_KEY }) > 0;

/**
 * Starts a sync, unless one runs: checked on the cache now, not on the next render, so a double
 * click or key repeat sends one. Shows the toast for a finished sync and refreshes everything it
 * can have changed.
 */
export function useSyncNow(onSettled?: () => void) {
  const queryClient = useQueryClient();
  const sync = useMutation({
    mutationKey: SYNC_NOW_KEY,
    mutationFn: syncNow,
    onSuccess: (counts) => toast.success(`Splitwise synced: ${syncSummary(counts)}`),
    onError: (err) => {
      // A sync a minute ago is not a failure: say so quietly.
      if (err instanceof SyncError && err.rateLimited) toast(err.message);
      else toast.error(err.message);
    },
    onSettled: () => {
      for (const queryKey of syncRefreshKeys()) void queryClient.invalidateQueries({ queryKey });
      onSettled?.();
    },
  });
  return () => {
    if (queryClient.isMutating({ mutationKey: SYNC_NOW_KEY }) === 0) sync.mutate();
  };
}

/**
 * The Splitwise expenses waiting on To link and the bank payment suggested for each. Shared by the
 * To link list and the payback questions (same cache), so both always agree on which payment To
 * link is asking about.
 */
export function useToLinkMatches() {
  const review = useQuery({ queryKey: REVIEW_KEY, queryFn: fetchReview });
  const items = useMemo(() => review.data?.items ?? [], [review.data]);
  const dates = items.map((i) => i.booking_date).sort();
  // Every input of the fetch: the window's ends and the currencies it reads rates for.
  const currencies = [...new Set(items.map((i) => i.currency))].sort().join(",");
  // Under "transactions" so the import's refresh keys refetch it after a link.
  const bank = useQuery({
    queryKey: ["transactions", "splitwise-to-link", dates[0], dates[dates.length - 1], currencies],
    queryFn: () =>
      fetchBankWindow(
        items.map((i) => i.booking_date),
        items.map((i) => i.currency),
      ),
    enabled: items.length > 0,
    // A link or ignore can move the window's ends (a new key): keep the last read meanwhile, so
    // what waits on it (the payback questions, the lists under them) doesn't blank and come back.
    placeholderData: keepPreviousData,
  });
  const rate = useMemo(() => makeRate(bank.data?.fx ?? []), [bank.data]);
  const suggestions = useMemo(
    () => suggestMatches(items, bank.data?.bank ?? [], rate),
    [items, bank.data, rate],
  );
  // Done once the list is read and, with items, their bank payments. A first failure counts as
  // done: what waits on this (the payback questions) shouldn't wait out the retries. Once done it
  // stays done: a Retry or a new window later updates the questions in place, it doesn't put the
  // page back to loading.
  const done = (q: { isPending: boolean; failureCount: number }) =>
    !q.isPending || q.failureCount > 0;
  const once = useRef(false);
  if (done(review) && (items.length === 0 || done(bank))) once.current = true;
  const settled = once.current;
  return { review, items, bank, rate, suggestions, settled };
}
