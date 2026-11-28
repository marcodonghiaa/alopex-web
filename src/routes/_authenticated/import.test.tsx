import { describe, expect, it } from "vitest";
import { Route } from "./import";

type BeforeLoad = (ctx: { location: { hash: string } }) => void;
const beforeLoad = Route.options.beforeLoad as unknown as BeforeLoad;

function redirectOf(hash: string) {
  try {
    beforeLoad({ location: { hash } });
  } catch (thrown) {
    return (thrown as { options: Record<string, unknown> }).options;
  }
  throw new Error("no redirect");
}

// protects=old /import links and home-screen bookmarks still reach the imports; fails_when=the
// old page 404s after the move to Settings › Import
describe("/import", () => {
  it("redirects to Settings › Import", () => {
    expect(redirectOf("")).toMatchObject({ to: "/settings/import", replace: true });
  });

  it("keeps the section anchor", () => {
    expect(redirectOf("spending")).toMatchObject({ to: "/settings/import", hash: "spending" });
  });
});
