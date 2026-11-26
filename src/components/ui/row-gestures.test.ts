import { describe, expect, it } from "vitest";
import { rubberBand, settleOpen } from "./row-gestures";

describe("settleOpen", () => {
  it("opens past half the actions, shuts before", () => {
    expect(settleOpen(-80, 0, 144)).toBe(true);
    expect(settleOpen(-60, 0, 144)).toBe(false);
  });
  it("lets a flick decide whatever the distance", () => {
    expect(settleOpen(-20, -0.8, 144)).toBe(true);
    expect(settleOpen(-130, 0.8, 144)).toBe(false);
  });
});

describe("rubberBand", () => {
  it("follows the finger up to the actions' width", () => {
    expect(rubberBand(-100, 144)).toBe(-100);
  });
  it("resists past the actions and when dragged right", () => {
    expect(rubberBand(-244, 144)).toBe(-174);
    expect(rubberBand(50, 144)).toBe(10);
  });
});
