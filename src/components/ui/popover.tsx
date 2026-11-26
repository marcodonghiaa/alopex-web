import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

type Padding = number | Partial<Record<"top" | "right" | "bottom" | "left", number>>;

/** A 16px gap from the screen edge (the page's phone gutter), plus room for the phone
 *  top bar and tab bar when they show, so a popover never opens underneath them. */
export function phoneBarPadding(gap = 16): Padding {
  if (typeof document === "undefined") return gap;
  const top = document.querySelector("[data-phone-bar=top]")?.getBoundingClientRect();
  const bottom = document.querySelector("[data-phone-bar=bottom]")?.getBoundingClientRect();
  if (!top?.height && !bottom?.height) return gap;
  return {
    top: top?.height ? top.bottom + 8 : gap,
    bottom: bottom?.height ? window.innerHeight - bottom.top + 8 : gap,
    left: gap,
    right: gap,
  };
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, collisionPadding, ...props }, ref) => {
  // Measured once per opening: a new padding object on every render makes Radix reposition forever.
  const [barPadding] = React.useState(phoneBarPadding);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding ?? barPadding}
        className={cn(
          "z-50 max-h-(--radix-popover-content-available-height) w-72 overflow-y-auto overscroll-contain rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-popover-content-transform-origin)",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent };
