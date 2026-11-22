import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const RECURRING_KEY = ["recurring_streams"];

/** Shared by the Subscriptions page and the nav badge, so they hit one cache entry. */
export const useRecurringStreams = () =>
  useQuery({
    queryKey: RECURRING_KEY,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from("recurring_streams").select("*");
      if (error) throw error;
      return data ?? [];
    },
  });

/**
 * Re-runs subscription detection for you (Edge Function refresh-recurring), so edits to your
 * transactions show at once instead of after the 6-hour run. Returns whether it ran; a failure
 * (demo, offline, a backend without the function) only keeps the list as last saved.
 */
export async function refreshRecurring(): Promise<boolean> {
  try {
    const { error } = await supabase.functions.invoke("refresh-recurring", { body: {} });
    if (error) throw error;
    return true;
  } catch (error) {
    // 429: re-checked moments ago (rate limited), nothing wrong.
    if ((error as { context?: Response })?.context?.status !== 429)
      console.warn("Couldn't re-check subscriptions", error);
    return false;
  }
}
