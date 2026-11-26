import type { ParsedLocation } from "@tanstack/react-router";

type Change = {
  fromLocation?: ParsedLocation | undefined;
  toLocation: ParsedLocation;
  pathChanged: boolean;
};

// A page change that follows a history step (Back, the edge swipe, or the browser's own) slides
// back; any other is a page opening. History indexes can't tell: More's links replace the sheet's
// entry, so a page opened from More shares the index of the page under it.
let stepped = false;
if (typeof window !== "undefined") window.addEventListener("popstate", () => (stepped = true));
/** Test hook: as if the browser had just stepped through history. */
export const markHistoryStep = () => (stepped = true);

/**
 * The iOS slide for a page change on a phone: "push" when a page opens, "pop" when a history step returns.
 * None between tabs (iOS swaps them in place), on the first load, for a sheet's own history step
 * (same address), on a wide screen, or with reduced motion.
 */
export function pageMotion(
  { fromLocation, toLocation, pathChanged }: Change,
  { isTab, phone }: { isTab: (path: string) => boolean; phone: boolean },
): Array<string> | false {
  const back = stepped;
  stepped = false;
  if (!phone || !fromLocation || !pathChanged) return false;
  if (isTab(fromLocation.pathname) && isTab(toLocation.pathname)) return false;
  return [back ? "pop" : "push"];
}

/** A phone-sized screen that allows motion (checked at each page change). */
export const phoneMotionOk = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 767.98px)").matches &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The router's view-transition setting: typed slides where the browser supports view transition
 * types (Safari 18.2+, Chrome 125+), else none, so an older browser never falls back to a cross-fade
 * of every page change.
 */
export function routerViewTransition(isTab: (path: string) => boolean) {
  const typed =
    typeof window !== "undefined" &&
    typeof document.startViewTransition === "function" &&
    !!window.CSS?.supports?.("selector(:active-view-transition-type(a))");
  if (!typed) return false;
  return { types: (c: Change) => pageMotion(c, { isTab, phone: phoneMotionOk() }) };
}
