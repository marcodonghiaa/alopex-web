import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const seen: Array<Record<string, unknown>> = [];
vi.mock("@radix-ui/react-popover", async (original) => ({
  ...(await original<typeof import("@radix-ui/react-popover")>()),
  Portal: ({ children }: { children: React.ReactNode }) => children,
  Content: (props: Record<string, unknown>) => {
    seen.push(props);
    return null;
  },
}));

import { PopoverContent } from "./popover";

describe("PopoverContent", () => {
  it("polish-5 #11 keeps a 16px gap from the screen edge on phones", () => {
    render(<PopoverContent />);
    expect(seen.at(-1)?.["collisionPadding"]).toBe(16);
  });

  it("keeps the same padding object across renders, or Radix repositions forever", () => {
    const bar = document.createElement("div");
    bar.setAttribute("data-phone-bar", "bottom");
    bar.getBoundingClientRect = () => ({ height: 86, top: 700, bottom: 786 }) as DOMRect;
    document.body.append(bar);
    const { rerender } = render(<PopoverContent />);
    const first = seen.at(-1)?.["collisionPadding"];
    rerender(<PopoverContent className="x" />);
    expect(typeof first).toBe("object");
    expect(seen.at(-1)?.["collisionPadding"]).toBe(first);
    bar.remove();
  });
});
