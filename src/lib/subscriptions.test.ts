import { describe, expect, it } from "vitest";
import { isStopped } from "./subscriptions";

const sub = (over: Partial<Parameters<typeof isStopped>[0]> = {}) => ({
  billing_frequency: "Monthly" as string | null,
  ...over,
});

const TODAY = new Date("2026-11-05T12:00:00");

// Regression: a cancelled subscription stayed "recurring" and kept counting in the monthly total.
describe("stopped subscriptions", () => {
  it("a monthly charge not seen for over two months is stopped and leaves the total", () => {
    expect(isStopped(sub({ last_charged: "2026-01-10" }), TODAY)).toBe(true);
    expect(isStopped(sub({ last_charged: "2026-10-20" }), TODAY)).toBe(false);
  });

  it("a yearly charge is still current eleven months later", () => {
    expect(isStopped(sub({ billing_frequency: "Yearly", last_charged: "2025-12-20" }), TODAY)).toBe(
      false,
    );
    expect(isStopped(sub({ billing_frequency: "Yearly", last_charged: "2025-08-01" }), TODAY)).toBe(
      true,
    );
  });

  it("a custom interval uses its own length", () => {
    const every2Weeks = {
      billing_frequency: "Custom",
      custom_interval_value: 2,
      custom_interval_unit: "weeks",
    };
    expect(isStopped(sub({ ...every2Weeks, last_charged: "2026-10-25" }), TODAY)).toBe(false);
    expect(isStopped(sub({ ...every2Weeks, last_charged: "2026-09-01" }), TODAY)).toBe(true);
  });

  it("without a known frequency nothing is called stopped", () => {
    expect(isStopped(sub({ billing_frequency: null, last_charged: "2020-01-01" }), TODAY)).toBe(
      false,
    );
  });
});
