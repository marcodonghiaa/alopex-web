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

// Before the backend migrations (table or icon/colour missing) or if it can't be read: what there
// is, down to the built-in list. `looks` says whether icons and colours can be saved.
async function fetchSettings(): Promise<{ rows: Array<CategorySetting>; looks: boolean } | null> {
  const full = await supabase.from("user_categories").select("name,hidden,icon,color");
  if (!full.error) {
    const rows = full.data as Array<CategorySetting>;
    setCategoryLooks(rows);
    return { rows, looks: true };
  }
  const { data, error } = await supabase.from("user_categories").select("name,hidden");
  if (error) return null;
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
  };
}
