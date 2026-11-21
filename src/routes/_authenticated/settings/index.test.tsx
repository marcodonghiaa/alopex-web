import { afterEach, describe, expect, it, vi } from "vitest";
import { Route } from "./index";

const beforeLoad = Route.options.beforeLoad as (ctx: { location: { hash: string } }) => void;
const wide = (matches: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches, media: q }) as MediaQueryList);

afterEach(() => vi.unstubAllGlobals());

// protects=desktop opens Settings on Overview (menu on the side); phones get the section list;
// old /settings#health links still reach Health. fails_when=any of the three breaks
describe("/settings", () => {
  it("opens Overview on desktop", () => {
    wide(true);
    expect(() => beforeLoad({ location: { hash: "" } })).toThrowError(
      expect.objectContaining({ options: expect.objectContaining({ to: "/settings/overview" }) }),
    );
  });

  it("shows the section list on a phone", () => {
    wide(false);
    expect(() => beforeLoad({ location: { hash: "" } })).not.toThrow();
  });

  it("sends an old #health link to Overview's Health section, even on a phone", () => {
    wide(false);
    expect(() => beforeLoad({ location: { hash: "health" } })).toThrowError(
      expect.objectContaining({
        options: expect.objectContaining({ to: "/settings/overview", hash: "health" }),
      }),
    );
  });
});
