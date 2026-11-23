import { describe, expect, it } from "vitest";
import { generateDemoData } from "@/lib/demo/generate";
import { EXPORT_TABLES } from "./tables";

// H022: the export says "everything in full" but left out custom categories, merchant renames and
// transfer-pair answers. fails_when=one of the user's own tables is dropped from data.json again.
describe("EXPORT_TABLES", () => {
  const names: Array<string> = EXPORT_TABLES.map((t) => t.name);

  it("includes custom categories, merchant renames and transfer pairs", () => {
    expect(names).toEqual(
      expect.arrayContaining(["user_categories", "merchant_aliases", "transfer_pairs"]),
    );
  });

  it("lists each table once", () => {
    expect(new Set(names).size).toBe(names.length);
  });

  // The demo's Export runs against its in-memory database, which refuses unknown tables.
  it("every exported table exists in the demo", () => {
    const demo = generateDemoData() as Record<string, unknown>;
    expect(names.filter((n) => !(n in demo))).toEqual([]);
  });
});
