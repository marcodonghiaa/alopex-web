import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CATEGORIES, categoriesFor, setCategoryLooks } from "@/lib/categories";

export type CategorySetting = {
  name: string;
  hidden: boolean;
  icon?: string | null;
  color?: string | null;
};

export const CATEGORIES_KEY = ["user-categories"];

// Undefined column, undefined table, and PostgREST's "not in the schema cache" for each.
const SCHEMA_ERRORS = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);
const isSchemaError = (error: { code?: string }) => SCHEMA_ERRORS.has(error.code ?? "");

// Before the backend migrations (table or icon/colour missing): what there is, down to the
// built-in list. `looks` says whether icons and colours can be saved. Any other error (network,
// server, a refused session) is thrown, so the query retries and reports it.
async function fetchSettings(): Promise<{ rows: Array<CategorySetting>; looks: boolean } | null> {
  const full = await supabase.from("user_categories").select("name,hidden,icon,color");
  if (!full.error) {
    const rows = full.data as Array<CategorySetting>;
    setCategoryLooks(rows);
    return { rows, looks: true };
  }
  if (!isSchemaError(full.error)) throw full.error;
  const { data, error } = await supabase.from("user_categories").select("name,hidden");
  if (error) {
    if (isSchemaError(error)) return null;
    throw error;
  }
  return { rows: data as Array<CategorySetting>, looks: false };
}

/** Your categories, for every picker: built-ins minus the hidden ones, plus your own. */
export function useCategories() {
  const query = useQuery({ queryKey: CATEGORIES_KEY, queryFn: fetchSettings, staleTime: 60_000 });
  const settings = query.data?.rows ?? [];
  return {
    list: query.data ? categoriesFor(settings) : [...CATEGORIES],
    settings,
    available: query.data != null,
    /** Icons, colours and safe delete need the 20261221 backend migration. */
    looksAvailable: query.data?.looks ?? false,
    isPending: query.isPending,
    /** The read failed for a reason other than a missing migration. */
    isError: query.isError,
  };
}
