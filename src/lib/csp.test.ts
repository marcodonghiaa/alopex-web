import { describe, expect, it } from "vitest";
import { connectSrc, contentSecurityPolicy } from "./csp";

describe("connectSrc", () => {
  it.each([
    [
      "https://abcdefghijklmnopqrst.supabase.co",
      "'self' https://abcdefghijklmnopqrst.supabase.co wss://abcdefghijklmnopqrst.supabase.co",
    ],
    [
      "https://supabase.example.org",
      "'self' https://supabase.example.org wss://supabase.example.org",
    ],
    [
      "https://db.example.org:8443/",
      "'self' https://db.example.org:8443 wss://db.example.org:8443",
    ],
    ["http://127.0.0.1:54321", "'self' http://127.0.0.1:54321 ws://127.0.0.1:54321"],
    [
      "http://supabase.lan:8000/some/path?x=1",
      "'self' http://supabase.lan:8000 ws://supabase.lan:8000",
    ],
  ])("allows the dashboard's own Supabase %s over http(s) and realtime ws(s)", (url, expected) => {
    expect(connectSrc(url)).toBe(`${expected} https://api.frankfurter.dev`);
  });

  it.each([
    undefined,
    "",
    "not a url",
    "ftp://files.example.org",
    "javascript:alert(1)",
    "https://a.example.org; script-src *",
  ])("falls back to 'self' only for a missing or unusable URL (%s)", (url) => {
    expect(connectSrc(url)).toBe("'self' https://api.frankfurter.dev");
  });

  it("reaches one public exchange-rate host besides the backend, so old wallet moves can be priced", () => {
    expect(connectSrc("https://own.supabase.co").split(" ")).toEqual([
      "'self'",
      "https://own.supabase.co",
      "wss://own.supabase.co",
      "https://api.frankfurter.dev",
    ]);
  });

  it("never allows every Supabase project, only the configured one", () => {
    expect(connectSrc("https://own.supabase.co")).not.toContain("*");
  });
});

describe("contentSecurityPolicy", () => {
  it("puts the configured backend into connect-src and keeps the rest of the policy", () => {
    const csp = contentSecurityPolicy("http://127.0.0.1:54321");
    expect(csp).toContain(
      "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321 https://api.frankfurter.dev;",
    );
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  // H356: no form-action, and default-src doesn't cover it, so an injected form could post
  // anywhere. Sign-in, bank links and Supabase redirects are navigations, not form posts.
  it("lets forms submit only to the dashboard itself", () => {
    const csp = contentSecurityPolicy("https://own.supabase.co");
    const directives = csp.split(/;\s*/);
    expect(directives).toContain("form-action 'self'");
    expect(directives.filter((d) => d.startsWith("form-action"))).toHaveLength(1);
  });
});
