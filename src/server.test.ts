// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const entryFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());
vi.mock("@tanstack/react-start/server-entry", () => ({ default: { fetch: entryFetch } }));

import server from "./server";

const HEADERS = [
  "Content-Security-Policy",
  "X-Frame-Options",
  "X-Content-Type-Options",
  "Referrer-Policy",
  "Strict-Transport-Security",
];

const get = () => server.fetch(new Request("https://dash.example/"), {}, {});

describe("server security headers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sets every header on a normal page", async () => {
    entryFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    for (const h of HEADERS) expect(res.headers.get(h)).toBeTruthy();
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
  });

  it("sets them on the error page when the handler throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    entryFetch.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("This page didn't load");
    for (const h of HEADERS) expect(res.headers.get(h)).toBeTruthy();
  });

  it("replaces h3's swallowed-error JSON with the error page, headers included", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    entryFetch.mockResolvedValue(
      new Response(JSON.stringify({ unhandled: true, message: "HTTPError" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("This page didn't load");
    for (const h of HEADERS) expect(res.headers.get(h)).toBeTruthy();
  });
});
