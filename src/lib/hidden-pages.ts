import { useSyncExternalStore } from "react";

// Pages a user can take out of the menus (Settings › App), saved on this device. The page still
// opens from a link; only the sidebar and More stop listing it. Core pages can't be hidden.
const KEY = "alopex.hiddenPages";

/** The pages Settings › App can switch off, in menu order. */
export const HIDEABLE_PAGES: ReadonlyArray<string> = [
  "/reports",
  "/income",
  "/budgets",
  "/subscriptions",
  "/splitwise",
  "/crypto",
  "/import",
];

const EMPTY: ReadonlyArray<string> = [];
let cached: ReadonlyArray<string> | undefined;
const listeners = new Set<() => void>();

/** The hidden pages. Anything stored that isn't a hideable page is ignored. */
export function hiddenPages(): ReadonlyArray<string> {
  if (cached === undefined) {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
      cached = Array.isArray(raw) ? HIDEABLE_PAGES.filter((p) => raw.includes(p)) : EMPTY;
    } catch {
      cached = EMPTY;
    }
  }
  return cached;
}

/** Shows or hides one page in the menus. False when the browser blocks storage. */
export function setPageHidden(path: string, hidden: boolean): boolean {
  const next = HIDEABLE_PAGES.filter((p) => (p === path ? hidden : hiddenPages().includes(p)));
  try {
    if (next.length) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch {
    return false;
  }
  cached = next;
  listeners.forEach((l) => l());
  return true;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed it.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== KEY) return; // null: the other tab cleared all storage
    cached = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The hidden pages, re-rendering when Settings (or another tab) changes them. */
export function useHiddenPages(): ReadonlyArray<string> {
  return useSyncExternalStore(subscribe, hiddenPages, () => EMPTY);
}
