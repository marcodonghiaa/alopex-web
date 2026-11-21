import { act, render, screen, within } from "@testing-library/react";
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

import { SettingsPageFrame, SettingsSidebar } from "./settings-nav";

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
    scrollRestoration: true, // as the app: a same-URL click restores the scroll, not the anchor
  });
  await act(() => router.load());
  render(<RouterProvider router={router} />);
  await screen.findAllByRole("link");
  return router;
}

describe("SettingsSidebar", () => {
  // polish-4 V6: on Rules you are still in Personalization; its row keeps the selected fill.
  it("keeps Personalization lit on its Rules sub-page", async () => {
    await at("/rules", <SettingsSidebar backTo={{ to: "/", search: {} }} />);
    const nav = within(screen.getByRole("navigation", { name: "Settings" }));
    expect(nav.getByRole("link", { name: "Personalization" })).toHaveClass("bg-sidebar-accent");
    expect(nav.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "App" })).not.toHaveClass("bg-sidebar-accent");
  });

  // polish-4 C1: Categories is an anchor; pressing it again after scrolling away scrolls back
  // instead of doing nothing (same URL, so the router doesn't move).
  it("scrolls back to Categories when pressed again on its own anchor", async () => {
    const scroll = vi.fn();
    await at(
      "/settings/personalization#categories",
      <>
        <SettingsSidebar backTo={{ to: "/", search: {} }} />
        <h2
          id="categories"
          ref={(el) => {
            if (el) el.scrollIntoView = scroll;
          }}
        >
          Categories
        </h2>
      </>,
    );
    act(() => screen.getByRole("link", { name: "Categories" }).click());
    await new Promise((r) => setTimeout(r, 50));
    // The router's own hash scroll passes `true`, and in a browser it restores the saved
    // window scroll instead; only our handler asks for { block: "start" }.
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
  });
});

describe("SettingsPageFrame", () => {
  // polish-4 A3: the phone back link goes to the list; it is never the page you are on.
  it("doesn't mark the back link to Settings as the current page", async () => {
    await at("/settings/app", <SettingsPageFrame title="App">x</SettingsPageFrame>);
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });
});
