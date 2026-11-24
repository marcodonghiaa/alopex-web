import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

import { AlreadyHeld, callAddHolding } from "./add-holding";

const failing = (body: string, status = 400) => ({
  data: null,
  error: { context: new Response(body, { status }) },
});

describe("callAddHolding", () => {
  it("returns the function's data", async () => {
    invoke.mockResolvedValue({ data: { ok: 1 }, error: null });
    await expect(callAddHolding({ q: "x" }, "fallback")).resolves.toEqual({ ok: 1 });
  });

  it("shows the function's own reason", async () => {
    invoke.mockResolvedValue(failing(JSON.stringify({ error: "No such ISIN" })));
    await expect(callAddHolding({}, "fallback")).rejects.toThrow("No such ISIN");
  });

  it("falls back when the body isn't JSON or has no reason", async () => {
    invoke.mockResolvedValue(failing("<html>"));
    await expect(callAddHolding({}, "fallback")).rejects.toThrow("fallback");
    invoke.mockResolvedValue(failing("{}"));
    await expect(callAddHolding({}, "fallback")).rejects.toThrow("fallback");
  });

  it("turns already_held into AlreadyHeld with its key", async () => {
    invoke.mockResolvedValue(failing(JSON.stringify({ error: "already_held", key: "k1" }), 409));
    const err = await callAddHolding({}, "fallback").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyHeld);
    expect((err as AlreadyHeld).key).toBe("k1");
  });

  it("falls back when there is no data", async () => {
    invoke.mockResolvedValue({ data: null, error: null });
    await expect(callAddHolding({}, "fallback")).rejects.toThrow("fallback");
  });
});
