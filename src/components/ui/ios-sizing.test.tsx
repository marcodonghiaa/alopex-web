import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { phoneBarPadding } from "./popover";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { NameEditor } from "@/components/transactions/name-editor";
import { MaskedIban } from "@/components/masked-iban";
import { CategoryEditor } from "@/components/settings/category-editor";

// protects=on an iPhone nothing opens under the Dynamic Island, the home indicator or the
// phone bars, and every tap target is at least 44pt (Apple HIG);
// fails_when=a popover ignores the tab bar, a tall dialog ignores safe areas, or a target shrinks.

function bar(name: "top" | "bottom", rect: Partial<DOMRect>) {
  const el = document.createElement("div");
  el.setAttribute("data-phone-bar", name);
  el.getBoundingClientRect = () => ({ height: 0, top: 0, bottom: 0, ...rect }) as DOMRect;
  document.body.append(el);
}

afterEach(() => document.querySelectorAll("[data-phone-bar]").forEach((el) => el.remove()));

describe("phoneBarPadding", () => {
  it("keeps the 16px gutter when the phone bars are hidden (desktop)", () => {
    bar("top", {});
    bar("bottom", {});
    expect(phoneBarPadding()).toBe(16);
  });

  it("clears the phone top bar and tab bar, plus an 8px gap", () => {
    bar("top", { height: 103, top: 0, bottom: 103 });
    bar("bottom", { height: 86, top: window.innerHeight - 86, bottom: window.innerHeight });
    expect(phoneBarPadding()).toEqual({ top: 111, bottom: 94, left: 16, right: 16 });
  });
});

describe("iPhone sizing", () => {
  it("a tall dialog stays clear of the notch and the home indicator", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Edit</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").className).toContain(
      "max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))]",
    );
  });

  it("the transaction name and the IBAN are 44pt tall to tap", () => {
    render(<NameEditor name="Spotify" onSave={() => {}} saving={false} />);
    render(<MaskedIban iban="IT60X0542811101000000123456" />);
    expect(screen.getByRole("button", { name: "Rename Spotify" }).className).toMatch(/\bpy-3\b/);
    expect(screen.getByRole("button", { name: "Show full IBAN" }).className).toMatch(/\bpy-3\.5\b/);
  });

  it("category icons and colours are 44pt choices, 6 to a row on a phone", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CategoryEditor target={{ kind: "new", name: "" }} categories={[]} onClose={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("radiogroup", { name: "Icon" }).className).toContain("grid-cols-6");
    expect(screen.getByRole("radio", { name: "First letter" }).className).toContain("min-h-11");
    expect(screen.getByRole("radio", { name: "Default colour" }).className).toContain("size-11");
  });
});
