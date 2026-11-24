import * as React from "react";

// Pixels a finger moves before we decide whether it's a sheet drag or a scroll.
const SLOP = 6;

/** A finished downward drag closes the sheet when it went far enough, or was a quick flick. */
export function shouldDismiss(dy: number, ms: number, height: number) {
  const far = dy > Math.min(120, height * 0.25);
  const flick = dy > 24 && dy / Math.max(ms, 1) > 0.5;
  return far || flick;
}

// True when the touch started inside something scrolled down: that pull scrolls it back up first.
function scrolledBetween(target: EventTarget | null, root: HTMLElement) {
  for (let el = target as HTMLElement | null; el; el = el.parentElement) {
    if (el.scrollTop > 0) return true;
    if (el === root) break;
  }
  return false;
}

/**
 * Swipe down to close a bottom sheet, like a native one: drag it from anywhere while its content
 * is scrolled to the top, let go past a quarter of its height (or flick) and it closes, otherwise
 * it springs back. A pull while the content is scrolled down still scrolls the content.
 */
export function useSwipeToDismiss(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onDismiss: () => void,
) {
  const dismiss = React.useRef(onDismiss);
  dismiss.current = onDismiss;

  React.useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let start: { x: number; y: number; t: number } | null = null;
    let dragging = false;
    let dy = 0;

    const reset = () => {
      start = null;
      dragging = false;
      dy = 0;
    };
    const onStart = (e: TouchEvent) => {
      reset();
      const t = e.touches[0];
      if (!t || e.touches.length !== 1 || scrolledBetween(e.target, el)) return;
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp };
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      if (!dragging) {
        if (Math.abs(dy) < SLOP && Math.abs(dx) < SLOP) return;
        // Upward or sideways: a scroll or a swipe on a control, not ours.
        if (dy <= 0 || Math.abs(dx) > dy) return reset();
        dragging = true;
        el.style.transition = "none";
      }
      // Ours now: the page and the sheet's content must not scroll or rubber-band under the finger.
      if (e.cancelable) e.preventDefault();
      el.style.transform = `translateY(${Math.max(0, dy)}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start || !dragging) return reset();
      // A cancelled touch (the system took it) springs back.
      const close =
        e.type === "touchend" && shouldDismiss(dy, e.timeStamp - start.t, el.offsetHeight);
      reset();
      if (close) {
        // The exit animation slides on from where the finger left the sheet.
        dismiss.current();
        return;
      }
      el.style.transition = "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)";
      el.style.transform = "";
      el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a drag has to stop the native scroll.
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [ref, enabled]);
}
