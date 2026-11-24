import { describe, expect, it } from "vitest";
import { isMissingFunction, isMissingTable } from "./pg-errors";

describe("isMissingFunction", () => {
  it("is PostgREST's no-such-function, by code or by message", () => {
    expect(isMissingFunction({ code: "PGRST202", message: "x" })).toBe(true);
    expect(isMissingFunction({ message: "Could not find the function public.f" })).toBe(true);
  });

  it("is not any other error", () => {
    expect(isMissingFunction({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingFunction({ code: "PGRST205" })).toBe(false);
  });
});

describe("isMissingTable", () => {
  it("is PostgREST's or Postgres's no-such-table", () => {
    expect(isMissingTable({ code: "PGRST205" })).toBe(true);
    expect(isMissingTable({ code: "42P01" })).toBe(true);
  });

  it("is not a missing column or a missing function", () => {
    expect(isMissingTable({ code: "42703" })).toBe(false);
    expect(isMissingTable({ code: "PGRST202" })).toBe(false);
  });
});
