import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const insert = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: () => getUser() },
    from: (table: string) => ({ insert: (row: unknown) => insert(table, row) }),
  },
}));

const { RULE_COLUMNS, insertRule } = await import("./rules-query");

// Polish 3 #12: the demo and the page mocks ignore select columns, so only this sees one dropped.
describe("RULE_COLUMNS", () => {
  it("reads every action, the income kind included", () => {
    expect(RULE_COLUMNS.split(", ")).toEqual(
      expect.arrayContaining([
        "set_category",
        "set_transaction_type",
        "set_flow_type",
        "set_income_kind",
      ]),
    );
  });
});

describe("insertRule", () => {
  const rule = { match_field: "any", match_mode: "word", match_text: "Bar", set_category: "X" };
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    insert.mockResolvedValue({ error: null });
  });

  it("saves the rule as the signed-in user, with its match mode", async () => {
    await insertRule(rule);
    expect(insert).toHaveBeenCalledWith("category_rules", { ...rule, user_id: "u1" });
  });

  it("refuses when signed out, saving nothing", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    await expect(insertRule(rule)).rejects.toThrow("signed out");
    expect(insert).not.toHaveBeenCalled();
  });

  it("throws the database's error", async () => {
    const error = { message: "denied" };
    insert.mockResolvedValue({ error });
    await expect(insertRule(rule)).rejects.toBe(error);
  });
});
