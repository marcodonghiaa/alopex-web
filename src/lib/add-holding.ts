import { supabase } from "@/integrations/supabase/client";

// add-holding answers errors as { error } with a 4xx/5xx; supabase-js wraps that in a generic
// message, so read the body to show the real reason.
async function functionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: Response }).context;
  try {
    const body = (await context?.json()) as { error?: string } | undefined;
    if (body?.error) return body.error;
  } catch {
    // Not JSON: fall through.
  }
  return fallback;
}

/** The add-holding Edge Function: search for an investment or a coin, or add one. */
export async function callAddHolding<T>(
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("add-holding", { body });
  if (error) throw new Error(await functionError(error, fallback));
  if (!data) throw new Error(fallback);
  return data;
}
