import { act, render, screen } from "@testing-library/react";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/mode", () => ({ isDemoMode: () => false }));

import { SettingsPageFrame } from "./settings-nav";

// The real router, so active states (aria-current) are what users get.
async function at(url: string, ui: React.ReactNode) {
  const root = createRootRoute({ component: Outlet });
  const paths = [
    "/",
    "/settings",
    "/settings/overview",
    "/settings/app",
    "/settings/personalization",
    "/settings/security",
    "/settings/account",
    "/rules",
  ];
  const router = createRouter({
    routeTree: root.addChildren(
      paths.map((path) =>
        createRoute({ getParentRoute: () => root, path, component: () => <>{ui}</> }),
      ),
    ),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  await screen.findAllByRole("link");
  return router;
}

describe("SettingsPageFrame", () => {
  // polish-4 A3: the phone back link goes to the list; it is never the page you are on.
  it("doesn't mark the back link to Settings as the current page", async () => {
    await at("/settings/app", <SettingsPageFrame title="App">x</SettingsPageFrame>);
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });
});
