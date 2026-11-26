import * as React from "react";

// Pixels a finger moves before we decide between a sideways swipe and a scroll.
const SLOP = 8;
// The strip along the left screen edge belongs to the iOS back gesture: a swipe starting there is not ours.
export const EDGE_GUTTER = 24;
// How long a finger rests on a row before its menu opens (iOS is about half a second).
export const LONG_PRESS_MS = 450;
const OPEN_EVENT = "alopex:row-swipe-open";
const SETTLE = "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";

/** Where a released row settles: a flick decides, otherwise whether it passed half the actions. */
export function settleOpen(offset: number, velocity: number, width: number) {
  if (velocity < -0.4) return true;
  if (velocity > 0.4) return false;
  return offset < -width / 2;
}

/** The row follows the finger up to its actions, then resists, like iOS rubber-banding. */
export function rubberBand(offset: number, width: number) {
  if (offset > 0) return offset * 0.2;
  if (offset < -width) return -width + (offset + width) * 0.3;
  return offset;
}

/**
 * iOS list-row gestures for a phone row: swipe left to reveal `width` px of actions behind it
 * (snaps open or shut, one open row at a time, a tap anywhere else shuts it), and a long press
 * that calls `onLongPress`. Vertical drags stay native scrolls. The click a gesture ends with is
 * swallowed, so a swipe or long press never also opens the row.
 */
export function useRowGestures({
  surface,
  content,
  width,
  onLongPress,
}: {
  surface: React.RefObject<HTMLElement | null>;
  content: React.RefObject<HTMLElement | null>;
  width: number;
  onLongPress?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const openRef = React.useRef(open);
  openRef.current = open;
  const longPress = React.useRef(onLongPress);
  longPress.current = onLongPress;

  // The row's resting place follows `open`, animated.
  React.useEffect(() => {
    const el = content.current;
    if (!el) return;
    el.style.transition = SETTLE;
    el.style.transform = open ? `translateX(${-width}px)` : "";
  }, [open, width, content]);

  // While open: shut when another row opens, the page scrolls, or a finger lands anywhere else.
  React.useEffect(() => {
    if (!open) return;
    const me = {};
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: me }));
    const shut = () => setOpen(false);
    const onOther = (e: Event) => (e as CustomEvent).detail !== me && shut();
    const onTouch = (e: Event) => {
      if (!surface.current?.contains(e.target as Node)) shut();
    };
    window.addEventListener(OPEN_EVENT, onOther);
    window.addEventListener("scroll", shut, { capture: true, passive: true });
    document.addEventListener("touchstart", onTouch, { capture: true, passive: true });
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther);
      window.removeEventListener("scroll", shut, { capture: true });
      document.removeEventListener("touchstart", onTouch, { capture: true });
    };
  }, [open, surface]);

  React.useEffect(() => {
    const el = surface.current;
    const row = content.current;
    if (!el || !row) return;
    let start: { x: number; y: number; t: number; base: number } | null = null;
    let mode: "undecided" | "swipe" | "scroll" = "undecided";
    let offset = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let swallowClick = false;

    const stopTimer = () => clearTimeout(timer);
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = null;
      // Any click a past gesture left unsent is not this touch's.
      swallowClick = false;
      if (!t || e.touches.length !== 1) return;
      mode = "undecided";
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, base: openRef.current ? -width : 0 };
      offset = start.base;
      stopTimer();
      if (longPress.current && !openRef.current) {
        timer = setTimeout(() => {
          swallowClick = true;
          start = null;
          longPress.current?.();
        }, LONG_PRESS_MS);
      }
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t || mode === "scroll") return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (mode === "undecided") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        stopTimer();
        const sideways = Math.abs(dx) > Math.abs(dy);
        // From the edge gutter the swipe is the system's back gesture, unless the row is already open.
        if (!sideways || (start.x < EDGE_GUTTER && !openRef.current)) {
          mode = "scroll";
          return;
        }
        mode = "swipe";
        row.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      offset = start.base + dx;
      row.style.transform = `translateX(${rubberBand(offset, width)}px)`;
    };
    const onEnd = (e: TouchEvent) => {
      stopTimer();
      if (!start || mode !== "swipe") {
        start = null;
        return;
      }
      const velocity = (offset - start.base) / Math.max(e.timeStamp - start.t, 1);
      const next = e.type === "touchend" && settleOpen(offset, velocity, width);
      start = null;
      swallowClick = true;
      row.style.transition = SETTLE;
      row.style.transform = next ? `translateX(${-width}px)` : "";
      setOpen(next);
    };
    // A tap on an open row's face shuts it instead of opening the row.
    const onClick = (e: MouseEvent) => {
      const onFace = row.contains(e.target as Node);
      if (swallowClick || (openRef.current && onFace)) {
        e.preventDefault();
        e.stopPropagation();
        if (!swallowClick) setOpen(false);
      }
      swallowClick = false;
    };
    // The long press is ours: no system menu on top of it.
    const onContextMenu = (e: Event) => {
      if (longPress.current) e.preventDefault();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: a sideways swipe has to stop the page from panning.
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("click", onClick, true);
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      stopTimer();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("click", onClick, true);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, [surface, content, width]);

  const close = React.useCallback(() => setOpen(false), []);
  return { open, close };
}
