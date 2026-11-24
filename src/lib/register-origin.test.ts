import { describe, it, expect, vi } from "vitest";
import { registerDashboardOrigin } from "./register-origin";

describe("registerDashboardOrigin", () => {
  it("calls the register function once", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "added", error: null });
    await registerDashboardOrigin(rpc);
    expect(rpc).toHaveBeenCalledOnce();
  });

  // H110: the Health page shows this answer (the table itself isn't readable from the browser).
  it("returns what the backend answered", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "full", error: null });
    await expect(registerDashboardOrigin(rpc)).resolves.toBe("full");
  });

  it("swallows a rejected call", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(registerDashboardOrigin(rpc)).resolves.toBeNull();
  });

  it("does not throw when the backend returns an error object", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "function not found" } });
    await expect(registerDashboardOrigin(rpc)).resolves.toBeNull();
  });
});
