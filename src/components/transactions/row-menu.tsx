import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { LucideIcon } from "lucide-react";

export type RowMenuItem = { label: string; icon: LucideIcon; onSelect: () => void };

// Height of one menu row plus the card's padding, to place the menu before it renders.
const ITEM_H = 48;
const GAP = 8;

/** Top of the menu: under the row when it fits above the tab bar, else over it. */
export function menuTop(rect: { top: number; bottom: number }, items: number, viewport: number) {
  const h = items * ITEM_H + GAP;
  const below = rect.bottom + GAP;
  // 88px keeps the menu clear of the phone tab bar and home indicator.
  if (below + h <= viewport - 88) return below;
  return Math.max(GAP, rect.top - GAP - h);
}

/**
 * iOS context menu for a long-pressed row: the page dims and blurs, the row lifts in place and
 * its actions float beside it. Esc, Back or a tap anywhere else closes it.
 */
export function RowMenu({
  title,
  rect,
  preview,
  items,
  onClose,
}: {
  title: string;
  rect: DOMRect;
  preview: ReactNode;
  items: Array<RowMenuItem>;
  onClose: () => void;
}) {
  const top = menuTop(rect, items.length, window.innerHeight);
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-md duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // A new touch outside the row and menu closes; the finger that opened it lifting does not.
          onPointerDown={(e) => e.target === e.currentTarget && onClose()}
          className="fixed inset-0 z-50 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <div
            aria-hidden
            className="pointer-events-none fixed flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-2xl duration-200 animate-in zoom-in-95 [scale:1.03]"
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          >
            {preview}
          </div>
          <div
            role="menu"
            aria-label={title}
            className="fixed right-4 w-56 overflow-hidden rounded-xl bg-card p-1 shadow-2xl duration-200 animate-in fade-in-0 zoom-in-95"
            style={{ top }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                onClick={item.onSelect}
                className="flex min-h-12 w-full items-center justify-between rounded-lg px-3 text-left text-[0.9375rem] text-foreground hover:bg-accent"
              >
                {item.label}
                <item.icon className="size-5 text-muted-foreground" aria-hidden />
              </button>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
