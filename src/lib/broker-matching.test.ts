import { describe, expect, it } from "vitest";
import { matchSummary } from "@/lib/broker-matching";

describe("matchSummary", () => {
  it("says what matched and what's left", () => {
    expect(matchSummary({ matched: 12, cleared: 0, unmatched: 3 })).toBe(
      "Matched 12 bank rows, 3 not matched yet",
    );
    expect(matchSummary({ matched: 1, cleared: 0, unmatched: 0 })).toBe("Matched 1 bank row");
    expect(matchSummary({ matched: 0, cleared: 0, unmatched: 2 })).toBe(
      "2 bank rows not matched yet",
    );
  });
  it("nothing when there's nothing to match, or it couldn't run", () => {
    expect(matchSummary({ matched: 0, cleared: 5, unmatched: 0 })).toBeUndefined();
    expect(matchSummary(null)).toBeUndefined();
  });
});
