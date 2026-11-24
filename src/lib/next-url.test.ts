import { afterEach, describe, it, expect, vi } from "vitest";
import { backHereSearch, safeNext, withSavedHash } from "./next-url";

describe("safeNext", () => {
  it("accepts a same-origin relative path", () => {
    expect(safeNext("/accounts")).toBe("/accounts");
  });

  it("keeps the search of a bank redirect", () => {
    expect(safeNext("/accounts?bank_code=x&bank_state=y")).toBe(
      "/accounts?bank_code=x&bank_state=y",
    );
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeNext("//evil.com")).toBeUndefined();
  });

  it("rejects the backslash bypass that URL() normalizes to protocol-relative", () => {
    expect(safeNext("/\\evil.com")).toBeUndefined();
  });

  it("rejects a non-string value", () => {
    expect(safeNext(42)).toBeUndefined();
    expect(safeNext(null)).toBeUndefined();
  });

  it("rejects a value that doesn't start with a slash", () => {
    expect(safeNext("evil.com")).toBeUndefined();
    expect(safeNext("https://evil.com")).toBeUndefined();
  });
});

// protects=after sign-in (or the authenticator code) the user is back on the page they were on;
// fails_when=the search or a bank's #bank_code is dropped, or "/" adds a useless ?next=
describe("backHereSearch", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  // H316: the hash went into ?next=, so a reload of /auth sent the bank's one-time code to the
  // dashboard host. It now waits in this tab's sessionStorage and comes back after sign-in.
  it("keeps the hash out of the URL and puts it back after sign-in", () => {
    const search = backHereSearch({
      pathname: "/accounts",
      searchStr: "?a=1",
      hash: "bank_code=x&bank_state=y",
    });
    expect(search).toEqual({ next: "/accounts?a=1" });
    expect(withSavedHash(search.next!)).toBe("/accounts?a=1#bank_code=x&bank_state=y");
    // Used once.
    expect(withSavedHash("/accounts?a=1")).toBe("/accounts?a=1");
  });

  it("keeps a page's hash even on the home page", () => {
    expect(backHereSearch({ pathname: "/", searchStr: "", hash: "bank_code=x" })).toEqual({
      next: "/",
    });
    expect(withSavedHash("/")).toBe("/#bank_code=x");
  });

  it("gives a saved hash only to the page it came from", () => {
    backHereSearch({ pathname: "/accounts", searchStr: "", hash: "bank_code=x" });
    expect(withSavedHash("/settings")).toBe("/settings");
  });

  it("falls back to the hash in next when sessionStorage can't be used", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(
      backHereSearch({ pathname: "/accounts", searchStr: "?a=1", hash: "bank_code=x" }),
    ).toEqual({ next: "/accounts?a=1#bank_code=x" });
  });
  it("adds nothing for the home page", () => {
    expect(backHereSearch({ pathname: "/", searchStr: "", hash: "" })).toEqual({});
  });
});
