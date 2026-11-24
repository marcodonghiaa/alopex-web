import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";

// The columns fetchRules selects, typed from the database (match_mode: "word" | "exact" |
// "contains"; rules made before modes are "contains").
export type RuleRow = Pick<
  Tables<"category_rules">,
  | "id"
  | "match_field"
  | "match_text"
  | "match_mode"
  | "set_category"
  | "set_transaction_type"
  | "set_flow_type"
  | "set_income_kind"
  | "priority"
  | "created_at"
>;

export const RULE_COLUMNS =
  "id, match_field, match_text, match_mode, set_category, set_transaction_type, set_flow_type, set_income_kind, priority, created_at";

async function fetchRules(): Promise<RuleRow[]> {
  const { data, error } = await supabase
    .from("category_rules")
    .select(RULE_COLUMNS)
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Saves a rule as the signed-in user. match_mode is required: the database default is
 * "contains", which lets a short name match inside longer ones. */
export async function insertRule(
  rule: Omit<TablesInsert<"category_rules">, "user_id"> & { match_mode: string },
): Promise<void> {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("You are signed out. Sign in again.");
  const { error } = await supabase
    .from("category_rules")
    .insert({ ...rule, user_id: data.user.id });
  if (error) throw error;
}

// One query for the user's rules, shared by the Rules page and "Make a rule" on Transactions.
export const rulesQuery = { queryKey: ["category-rules"], queryFn: fetchRules } as const;
