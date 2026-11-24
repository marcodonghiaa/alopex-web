import { supabase } from "@/integrations/supabase/client";
import { functionErrorBody, functionErrorMessage } from "@/lib/function-error";

/** add-holding's 409 `already_held`: you hold this security already, under `key`. */
export class AlreadyHeld extends Error {
  constructor(readonly key: string) {
    super("Already in your holdings: change its quantity instead");
  }
}

/** The add-holding Edge Function: search for an investment or a coin, or add one. */
export async function callAddHolding<T>(
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>("add-holding", { body });
  if (error) {
    const body = (await functionErrorBody(error)) as { error?: unknown; key?: unknown } | null;
    if (body?.error === "already_held" && typeof body.key === "string")
      throw new AlreadyHeld(body.key);
    throw new Error(await functionErrorMessage(error, fallback));
  }
  if (!data) throw new Error(fallback);
  return data;
}
