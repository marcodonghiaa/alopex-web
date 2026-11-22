import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const demo = vi.hoisted(() => ({ current: false }));
vi.mock("@/lib/demo/mode", () => ({ isDemoMode: () => demo.current }));
vi.mock("@/components/settings/change-password-form", () => ({
  ChangePasswordForm: () => <h2>Password</h2>,
}));
vi.mock("@/components/settings/two-factor-section", () => ({
  TwoFactorSection: () => <h2>Two-step</h2>,
}));
vi.mock("@/components/settings/delete-account", () => ({ DeleteAccount: () => <h2>Delete</h2> }));
vi.mock("@/components/settings/export-data", () => ({ ExportData: () => <h2>Export</h2> }));
vi.mock("@/components/settings/categories-section", () => ({
  CategoriesSection: () => <h2>Categories</h2>,
}));
vi.mock("@/components/settings/rules-section", () => ({ RulesSection: () => <h2>Rules</h2> }));
vi.mock("@/components/health/health-section", () => ({
  HealthSection: () => <h2>Health</h2>,
  NotificationsSection: () => <h2>Notifications</h2>,
  GetTheAppSection: () => <h2>Get the phone app</h2>,
}));
vi.mock("@/components/settings/formats-section", () => ({
  FormatsSection: () => <h2>Number and date format</h2>,
}));
vi.mock("@/components/settings/menu-pages-section", () => ({
  MenuPagesSection: () => <h2>Pages in the menu</h2>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

import {
  AccountSettingsPage,
  AppSettingsPage,
  OverviewSettingsPage,
  PersonalizationSettingsPage,
  SecuritySettingsPage,
  SettingsIndexPage,
} from "./settings-page";

const order = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

// protects=each settings page holds what the whiteboard put there; Health stays first in
// Overview (#14); fails_when=a section moves to the wrong page or drops out
describe("settings pages", () => {
  it("Overview: Health first, then format, then notifications (phone) or the app (desktop)", () => {
    demo.current = false;
    render(<OverviewSettingsPage />);
    // Named General (owner's call, 2026-11-22): "Overview" is already the app's first nav group.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("General");
    expect(order()).toEqual([
      "Health",
      "Number and date format",
      "Notifications",
      "Get the phone app",
    ]);
  });

  it("App, Personalization, Security and Account", () => {
    demo.current = false;
    const { unmount } = render(<AppSettingsPage />);
    expect(order()).toEqual(["Pages in the menu"]);
    unmount();
    const p = render(<PersonalizationSettingsPage />);
    expect(order()).toEqual(["Categories", "Rules"]);
    p.unmount();
    const sec = render(<SecuritySettingsPage />);
    expect(order()).toEqual(["Password", "Two-step"]);
    sec.unmount();
    render(<AccountSettingsPage />);
    expect(order()).toEqual(["Export", "Delete"]);
  });

  it("leaves out the account sections in the demo", () => {
    demo.current = true;
    const sec = render(<SecuritySettingsPage />);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.getByText(/Not available in the demo/)).toBeInTheDocument();
    sec.unmount();
    render(<AccountSettingsPage />);
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("phone: Settings opens on the section list; the demo has no Security or Account", () => {
    demo.current = false;
    const { unmount } = render(<SettingsIndexPage />);
    const labels = () => screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(labels()).toEqual([
      "/settings/overview",
      "/settings/app",
      "/settings/personalization",
      "/settings/security",
      "/settings/account",
    ]);
    unmount();
    demo.current = true;
    render(<SettingsIndexPage />);
    expect(labels()).toEqual(["/settings/overview", "/settings/app", "/settings/personalization"]);
    expect(screen.getAllByRole("link")[0]).toHaveTextContent(/^General/);
  });

  it("each section page has a phone back link to the list", () => {
    demo.current = false;
    render(<AppSettingsPage />);
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  // polish-4 V3: DESIGN.md's 32px top padding, same as Rules, so the title doesn't jump
  // between Personalization and Rules. fails_when=a settings page goes back to py-6
  it("uses the standard 32px top padding, like Rules", () => {
    demo.current = false;
    const { unmount } = render(<SettingsIndexPage />);
    expect(screen.getByRole("heading", { level: 1 }).parentElement).toHaveClass("py-8");
    unmount();
    render(<AppSettingsPage />);
    expect(screen.getByRole("heading", { level: 1 }).closest(".max-w-5xl")).toHaveClass("py-8");
  });
});
