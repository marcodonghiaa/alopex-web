import * as React from "react";
import { isOverlayOpen } from "./close-on-back";
import { EDGE_GUTTER } from "./row-gestures";

// How far right a finger from the left edge must travel to go Back (iOS goes at about a third).
export const BACK_DISTANCE = 0.33;
const SETTLE = "transform 250ms cubic-bezier(0.32, 0.72, 0, 1)";

/** Home-screen app: iOS gives it no system Back swipe, so the app draws its own. */
export const standalone = () =>
  typeof window !== "undefined" &&
  ((navigator as { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches);

/** Whether a released edge swipe goes Back: far enough, or a quick flick to the right. */
export function swipeGoesBack(dx: number, velocity: number, width: number) {
  return dx > width * BACK_DISTANCE || (dx > 40 && velocity > 0.5);
}

/**
 * iOS swipe from the left screen edge to go Back, for a home-screen app on a page that has a Back.
 * The page follows the finger; let go past a third (or flick) and `onBack` runs, else it slides
 * home. A sheet or dialog on screen keeps the swipe to itself. `page` keeps the offset until
 * `resetKey` (the address) changes, so the Back slide starts where the finger left it.
 */
export function useEdgeSwipeBack(
  page: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
  resetKey: string,
) {
  const back = React.useRef(onBack);
  back.current = onBack;

  React.useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    el.style.transition = "";
    el.style.transform = "";
  }, [resetKey, page]);

  React.useEffect(() => {
    if (!enabled || !standalone()) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let dx = 0;
    const el = () => page.current;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = null;
      dragging = false;
      if (!t || e.touches.length !== 1 || t.clientX > EDGE_GUTTER || isOverlayOpen()) return;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      dx = Math.max(0, t.clientX - start.x);
      const dy = t.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dy) > 10 && Math.abs(dy) > dx) {
          start = null;
          return;
        }
        if (dx < 10) return;
        dragging = true;
        const p = el();
        if (p) p.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      const p = el();
      if (p) p.style.transform = `translateX(${dx}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || !dragging) {
        start = null;
        return;
      }
      const velocity = dx / Math.max(e.timeStamp - start.t, 1);
      start = null;
      dragging = false;
      if (e.type === "touchend" && swipeGoesBack(dx, velocity, window.innerWidth)) {
        back.current();
        // The new page normally clears the offset; this catches a Back that went nowhere.
        setTimeout(() => {
          const p = el();
          if (p?.style.transform) {
            p.style.transition = SETTLE;
            p.style.transform = "";
          }
        }, 1000);
        return;
      }
      const p = el();
      if (p) {
        p.style.transition = SETTLE;
        p.style.transform = "";
      }
    };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled, page]);
}
