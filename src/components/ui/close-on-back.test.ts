import { afterEach, describe, expect, it, vi } from "vitest";

// H334: a reload on a sheet's history entry, or Forward back onto one, left an entry with nothing
// open, so the next Back looked like it did nothing. Such an entry is now stepped back over.
describe("a sheet's history entry with no sheet open", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    window.history.replaceState(null, "", "/");
  });

  it("is stepped back over when the app starts on it (a reload)", async () => {
    window.history.replaceState({ page: 1, __sheet: "old", __depth: 1 }, "");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await import("./close-on-back");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("is left alone on a normal start", async () => {
    window.history.replaceState({ page: 1 }, "");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    await import("./close-on-back");
    expect(back).not.toHaveBeenCalled();
  });

  it("is stepped back over when Forward lands on it", async () => {
    await import("./close-on-back");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const state = { page: 1, __sheet: "closed", __depth: 1 };
    window.history.replaceState(state, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state }));
    // (Each test's fresh import adds its own listener, so count calls loosely.)
    expect(back).toHaveBeenCalled();
  });

  it("leaves a page's own entry alone on Back", async () => {
    await import("./close-on-back");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    window.history.replaceState({ page: 1 }, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: { page: 1 } }));
    expect(back).not.toHaveBeenCalled();
  });
});
