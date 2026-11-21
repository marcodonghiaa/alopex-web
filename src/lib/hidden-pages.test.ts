import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const load = async () => {
  vi.resetModules();
  return import("./hidden-pages");
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// protects=Settings › App can take an unused page out of the menus, per device (whiteboard note)
describe("hidden pages", () => {
  it("starts with nothing hidden and saves a hidden page", async () => {
    const m = await load();
    expect(m.hiddenPages()).toEqual([]);
    expect(m.setPageHidden("/budgets", true)).toBe(true);
    expect(m.hiddenPages()).toEqual(["/budgets"]);
    expect(JSON.parse(localStorage.getItem("alopex.hiddenPages")!)).toEqual(["/budgets"]);
    m.setPageHidden("/budgets", false);
    expect(m.hiddenPages()).toEqual([]);
    expect(localStorage.getItem("alopex.hiddenPages")).toBeNull();
  });

  it("ignores core pages and junk in storage", async () => {
    localStorage.setItem("alopex.hiddenPages", JSON.stringify(["/", "/budgets", 3]));
    const m = await load();
    expect(m.hiddenPages()).toEqual(["/budgets"]);
    localStorage.setItem("alopex.hiddenPages", "{not json");
    const m2 = await load();
    expect(m2.hiddenPages()).toEqual([]);
    expect(m2.setPageHidden("/", true)).toBe(true);
    expect(m2.hiddenPages()).toEqual([]);
  });

  it("says so when the browser blocks storage, and keeps the old list", async () => {
    const m = await load();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(m.setPageHidden("/income", true)).toBe(false);
    expect(m.hiddenPages()).toEqual([]);
  });

  it("re-renders readers on a change here or in another tab", async () => {
    const m = await load();
    const { result } = renderHook(() => m.useHiddenPages());
    expect(result.current).toEqual([]);
    act(() => void m.setPageHidden("/crypto", true));
    expect(result.current).toEqual(["/crypto"]);
    act(() => {
      localStorage.setItem("alopex.hiddenPages", JSON.stringify(["/import"]));
      window.dispatchEvent(new StorageEvent("storage", { key: "alopex.hiddenPages" }));
    });
    expect(result.current).toEqual(["/import"]);
  });
});
