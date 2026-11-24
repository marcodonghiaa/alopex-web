import { describe, expect, it, vi } from "vitest";

// A stand-in for auth-js: it reads the recovery link while getSession waits, then announces
// PASSWORD_RECOVERY in a timer, after getSession has already answered.
const auth = vi.hoisted(() => ({
  listener: null as null | ((event: string) => void),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => {
        auth.listener = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      getSession: async () => {
        setTimeout(() => auth.listener?.("PASSWORD_RECOVERY"), 0);
        return { data: { session: { user: { id: "u1" } } }, error: null };
      },
    },
  }),
}));

import { openedFromRecoveryLink, recoverySignIn } from "./client";

// H114: the dashboard guard asks this before letting a session in.
describe("recoverySignIn", () => {
  it("sees a recovery link announced just after the session is read", async () => {
    expect(await recoverySignIn()).toBe(true);
    expect(openedFromRecoveryLink()).toBe(true);
  });

  it("ends once the new password is saved, so the dashboard opens again", async () => {
    auth.listener?.("USER_UPDATED");
    expect(await recoverySignIn()).toBe(false);
    expect(openedFromRecoveryLink()).toBe(false);
  });
});
