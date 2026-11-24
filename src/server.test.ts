import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  },
}));

import server from "./server";

const headersOf = async () =>
  (await server.fetch(new Request("https://money.example.org/"), {}, {})).headers;

describe("security headers", () => {
  // H357: includeSubDomains pinned every subdomain of a self-hoster's domain (a NAS, a router
  // page on plain http) to HTTPS for a year. HSTS now covers only the dashboard's own host.
  it("asks for HTTPS on the dashboard's own host only", async () => {
    expect((await headersOf()).get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("sends the CSP with form-action, and the framing and sniffing guards", async () => {
    const h = await headersOf();
    expect(h.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });
});
