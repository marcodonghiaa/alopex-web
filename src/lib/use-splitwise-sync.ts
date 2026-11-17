import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CONNECTION_KEY,
  fetchConnection,
  syncNow,
  syncRefreshKeys,
  syncSummary,
  SyncError,
} from "@/lib/splitwise-sync";

/** The user's Splitwise connection. A backend without the sync reads as not connected. */
export function useSplitwiseConnection() {
  return useQuery({ queryKey: CONNECTION_KEY, queryFn: fetchConnection, staleTime: 30_000 });
}

/** Shows the toast for a finished sync and refreshes everything it can have changed. */
export function useSyncNow(onSettled?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
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
}
