import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Sheet, SheetContent, SheetTitle } from "./sheet";
import { shouldDismiss } from "./swipe-to-dismiss";

// react-remove-scroll (under every Radix sheet) reads the touch from changedTouches too.
const pt = (p: { clientX: number; clientY: number }) => ({ touches: [p], changedTouches: [p] });
const end = { touches: [], changedTouches: [{ clientX: 0, clientY: 0 }] };

describe("shouldDismiss", () => {
  it("closes past a quarter of the sheet (capped at 120px)", () => {
    expect(shouldDismiss(130, 1000, 800)).toBe(true);
    expect(shouldDismiss(90, 1000, 300)).toBe(true);
  });
  it("closes on a quick flick", () => {
    expect(shouldDismiss(40, 50, 800)).toBe(true);
  });
  it("springs back from a short, slow pull", () => {
    expect(shouldDismiss(60, 1000, 800)).toBe(false);
    expect(shouldDismiss(20, 10, 800)).toBe(false);
  });
});

// Marco's phone recording (2026-11-24): pulling a bottom sheet down only rubber-banded it;
// native sheets close. fails_when=a downward drag on a bottom sheet doesn't close it
describe("bottom sheet swipe", () => {
  afterEach(cleanup);
  const renderSheet = (side: "bottom" | "right" = "bottom") => {
    const onOpenChange = vi.fn();
    render(
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent side={side} aria-describedby={undefined}>
          <SheetTitle>Hotel</SheetTitle>
          <div data-testid="list" style={{ overflowY: "auto" }}>
            rows
          </div>
        </SheetContent>
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog");
    Object.defineProperty(sheet, "offsetHeight", { value: 800 });
    return { onOpenChange, sheet };
  };
  const drag = (el: HTMLElement, from: number, to: number, x = 100) => {
    fireEvent.touchStart(el, pt({ clientX: x, clientY: from }));
    fireEvent.touchMove(el, pt({ clientX: x, clientY: (from + to) / 2 }));
    fireEvent.touchMove(el, pt({ clientX: x, clientY: to }));
  };

  it("follows the finger, then closes after a long pull", () => {
    const { onOpenChange, sheet } = renderSheet();
    drag(screen.getByText("Hotel"), 100, 300);
    expect(sheet.style.transform).toBe("translateY(200px)");
    fireEvent.touchEnd(sheet, end);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("springs back after a short pull", () => {
    const { onOpenChange, sheet } = renderSheet();
    drag(sheet, 100, 120);
    fireEvent.touchEnd(sheet, end);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe("");
  });

  it("springs back when the system cancels the touch", () => {
    const { onOpenChange, sheet } = renderSheet();
    drag(sheet, 100, 400);
    fireEvent.touchCancel(sheet, end);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe("");
  });

  it("leaves an upward swipe to scrolling", () => {
    const { sheet } = renderSheet();
    drag(sheet, 300, 100);
    expect(sheet.style.transform).toBe("");
  });

  it("leaves a sideways swipe alone", () => {
    const { sheet } = renderSheet();
    fireEvent.touchStart(sheet, pt({ clientX: 100, clientY: 100 }));
    fireEvent.touchMove(sheet, pt({ clientX: 200, clientY: 130 }));
    expect(sheet.style.transform).toBe("");
  });

  it("scrolls content back up first when it is scrolled down", () => {
    const { onOpenChange, sheet } = renderSheet();
    const list = screen.getByTestId("list");
    list.scrollTop = 50;
    drag(list, 100, 400);
    fireEvent.touchEnd(list, end);
    expect(sheet.style.transform).toBe("");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("does nothing on a side panel", () => {
    const { onOpenChange, sheet } = renderSheet("right");
    drag(sheet, 100, 400);
    fireEvent.touchEnd(sheet, end);
    expect(sheet.style.transform).toBe("");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
