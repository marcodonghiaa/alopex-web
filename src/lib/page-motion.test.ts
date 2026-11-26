import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedLocation } from "@tanstack/react-router";
import { markHistoryStep, pageMotion, routerViewTransition } from "./page-motion";

const at = (pathname: string) => ({ pathname }) as ParsedLocation;
const isTab = (p: string) => ["/", "/transactions"].includes(p);
const change = (from: string | undefined, to: string) => ({
  fromLocation: from === undefined ? undefined : at(from),
  toLocation: at(to),
  pathChanged: from !== to,
});
const phone = { isTab, phone: true };

describe("pageMotion", () => {
  it("pushes when a page opens", () => {
    expect(pageMotion(change("/", "/accounts"), phone)).toEqual(["push"]);
  });

  it("pops after a history step (Back, edge swipe, browser), then pushes again", () => {
    markHistoryStep();
    expect(pageMotion(change("/accounts", "/"), phone)).toEqual(["pop"]);
    expect(pageMotion(change("/", "/accounts"), phone)).toEqual(["push"]);
  });

  it("doesn't slide between tabs", () => {
    expect(pageMotion(change("/", "/transactions"), phone)).toBe(false);
  });

  it("doesn't slide on the first load, a sheet's own history step or a wide screen", () => {
    expect(pageMotion(change(undefined, "/accounts"), phone)).toBe(false);
    markHistoryStep();
    expect(pageMotion(change("/accounts", "/accounts"), phone)).toBe(false);
    // The sheet's step is used up: the next opening is a push.
    expect(pageMotion(change("/", "/accounts"), phone)).toEqual(["push"]);
    expect(pageMotion(change("/", "/accounts"), { isTab, phone: false })).toBe(false);
  });
});

describe("routerViewTransition", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is off where the browser has no typed view transitions (no cross-fade fallback)", () => {
    expect(routerViewTransition(isTab)).toBe(false);
  });

  it("gives typed slides where it has them", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    Object.assign(document, { startViewTransition: () => ({}) });
    const vt = routerViewTransition(isTab);
    delete (document as Partial<Document>).startViewTransition;
    expect(vt).toMatchObject({ types: expect.any(Function) });
  });
});
