import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const rpc = vi.fn();
const eq = vi.fn();
const del = vi.fn(() => ({ eq }));
const from = vi.fn(() => ({
  delete: del,
  select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (...args: unknown[]) => from(...(args as [])),
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const demo = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/demo/mode", () => ({ isDemoMode: () => demo.on }));

import { PushSubscribeButton, forgetThisBrowserPush } from "./push-subscribe";

const unsubscribe = vi.fn(async () => true);
let current: {
  endpoint: string;
  unsubscribe: typeof unsubscribe;
  options?: { applicationServerKey: ArrayBuffer | null };
} | null = null;
const fresh = {
  endpoint: "https://push.example/abc",
  unsubscribe,
  toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "pk", auth: "ak" } }),
};
const registration = {
  pushManager: {
    getSubscription: async () => current,
    subscribe: async () => fresh,
  },
};

beforeEach(() => {
  rpc.mockReset();
  eq.mockReset();
  eq.mockResolvedValue({ error: null });
  unsubscribe.mockClear();
  current = null;
  demo.on = false;
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async () => registration,
      ready: Promise.resolve(registration),
      getRegistration: async () => registration,
    },
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: async () => "granted",
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("PushSubscribeButton", () => {
  it("H018 claims this browser's endpoint for the signed-in user", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    render(<PushSubscribeButton />);
    fireEvent.click(await screen.findByRole("button"));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("claim_push_subscription", {
        p_endpoint: "https://push.example/abc",
        p_p256dh: "pk",
        p_auth: "ak",
      }),
    );
    expect(await screen.findByText("Check-ins enabled")).toBeInTheDocument();
  });

  it("stays off when the claim fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "invalid push endpoint" } });
    render(<PushSubscribeButton />);
    fireEvent.click(await screen.findByRole("button"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByText("Check-ins enabled")).not.toBeInTheDocument();
  });

  it("replaces a subscription made with an old VAPID key", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    current = { ...fresh, options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer } };
    render(<PushSubscribeButton />);
    fireEvent.click(await screen.findByRole("button"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("keeps the subscription when the browser hides its key", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    current = { ...fresh, options: { applicationServerKey: null } };
    render(<PushSubscribeButton />);
    fireEvent.click(await screen.findByRole("button"));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});

describe("forgetThisBrowserPush", () => {
  it("H018 removes this browser's subscription on sign-out", async () => {
    current = fresh;
    await forgetThisBrowserPush();
    expect(from).toHaveBeenCalledWith("push_subscriptions");
    expect(eq).toHaveBeenCalledWith("endpoint", "https://push.example/abc");
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("does nothing when this browser has no subscription", async () => {
    await forgetThisBrowserPush();
    expect(eq).not.toHaveBeenCalled();
  });

  it("keeps the browser subscribed when the row could not be removed", async () => {
    current = fresh;
    eq.mockResolvedValue({ error: { message: "offline" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await forgetThisBrowserPush();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("leaves the real account's subscription alone when leaving the demo", async () => {
    current = fresh;
    demo.on = true;
    await forgetThisBrowserPush();
    expect(eq).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("gives up after a few seconds so sign-out can't hang", async () => {
    vi.useFakeTimers();
    current = fresh;
    eq.mockReturnValue(new Promise(() => {}));
    const done = forgetThisBrowserPush();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("never blocks sign-out when the cleanup fails", async () => {
    current = fresh;
    eq.mockRejectedValue(new Error("offline"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(forgetThisBrowserPush()).resolves.toBeUndefined();
    log.mockRestore();
  });
});
