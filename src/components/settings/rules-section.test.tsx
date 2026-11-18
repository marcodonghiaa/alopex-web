import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

import { RulesSection } from "./rules-section";

// protects=Rules left the sidebar for Settings, so this row is now its way in;
// fails_when=the row goes or points somewhere else
describe("RulesSection", () => {
  it("links to the Rules page under a Rules heading", () => {
    render(<RulesSection />);
    expect(screen.getByRole("heading", { level: 2, name: "Rules" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Category rules/ })).toHaveAttribute("href", "/rules");
  });
});
