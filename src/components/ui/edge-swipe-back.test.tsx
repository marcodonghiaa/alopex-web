import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { swipeGoesBack, useEdgeSwipeBack } from "./edge-swipe-back";
import { useCloseOnBack } from "./close-on-back";

function Page({
  onBack,
  enabled = true,
  overlay = false,
}: {
  onBack: () => void;
  enabled?: boolean;
  overlay?: boolean;
}) {
  const page = React.useRef<HTMLElement>(null);
  useEdgeSwipeBack(page, enabled, onBack, "/accounts");
  useCloseOnBack(overlay, () => {});
  return <main ref={page} data-testid="page" />;
}

const touch = (x: number, y = 300) => ({ touches: [{ clientX: x, clientY: y }] });
function swipe(fromX: number, toX: number, dy = 0) {
  fireEvent.touchStart(document, touch(fromX));
  for (let x = fromX + 10; x <= toX; x += 10) fireEvent.touchMove(document, touch(x, 300 + dy));
  fireEvent.touchEnd(document, { touches: [] });
}

describe("swipeGoesBack", () => {
  it("goes past a third of the screen, or on a quick flick", () => {
    expect(swipeGoesBack(140, 0.1, 390)).toBe(true);
    expect(swipeGoesBack(100, 0.1, 390)).toBe(false);
    expect(swipeGoesBack(60, 0.8, 390)).toBe(true);
    expect(swipeGoesBack(30, 0.8, 390)).toBe(false);
  });
});

describe("useEdgeSwipeBack", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  });
  afterEach(() => {
    delete (navigator as { standalone?: boolean }).standalone;
  });

  it("goes Back after a swipe from the left edge, the page following the finger", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Page onBack={onBack} />);
    fireEvent.touchStart(document, touch(5));
    fireEvent.touchMove(document, touch(60));
    expect(getByTestId("page").style.transform).toBe("translateX(55px)");
    for (let x = 70; x <= 200; x += 10) fireEvent.touchMove(document, touch(x));
    fireEvent.touchEnd(document, { touches: [] });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("slides the page home when let go early", () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Page onBack={onBack} />);
    fireEvent.touchStart(document, touch(5));
    fireEvent.touchMove(document, touch(35));
    fireEvent.touchEnd(document, { touches: [] });
    expect(onBack).not.toHaveBeenCalled();
    expect(getByTestId("page").style.transform).toBe("");
  });

  it("ignores a swipe that starts away from the edge, or a vertical scroll from it", () => {
    const onBack = vi.fn();
    render(<Page onBack={onBack} />);
    swipe(60, 300);
    swipe(5, 15, 200);
    expect(onBack).not.toHaveBeenCalled();
  });

  it("leaves the swipe to an open sheet, a page without Back, and a browser tab", () => {
    const onBack = vi.fn();
    const { unmount } = render(<Page onBack={onBack} overlay />);
    swipe(5, 300);
    unmount();
    const off = render(<Page onBack={onBack} enabled={false} />);
    swipe(5, 300);
    off.unmount();
    delete (navigator as { standalone?: boolean }).standalone;
    render(<Page onBack={onBack} />);
    swipe(5, 300);
    expect(onBack).not.toHaveBeenCalled();
  });
});
