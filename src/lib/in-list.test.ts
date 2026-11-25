import { describe, expect, it } from "vitest";
import { inList } from "./in-list";

describe("inList", () => {
  // protects=user-named categories reach the server filter as written; fails_when=a quote, comma
  // or bracket in a name breaks the list or splits one name into two
  it("quotes every value and escapes quotes and backslashes", () => {
    expect(inList(["Food", 'Kids "school"', "Food, (extras)", "a\\b"])).toBe(
      '("Food","Kids \\"school\\"","Food, (extras)","a\\\\b")',
    );
  });
});
