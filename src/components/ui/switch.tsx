import type { InputHTMLAttributes } from "react";

// On/off switch: a native checkbox with role="switch", drawn as a 51×31 track. Ink when on
// (DESIGN.md: green only means a gain); the off track stays visible on a white row (3:1). Put it inside a <label> or give it aria-label / aria-labelledby.
export function Switch(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <>
      <input type="checkbox" role="switch" {...props} className="peer sr-only" />
      <span
        aria-hidden
        className="relative h-[31px] w-[51px] shrink-0 rounded-full bg-foreground/45 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:absolute after:top-[2px] after:left-[2px] after:size-[27px] after:rounded-full after:bg-background after:transition-transform peer-checked:after:translate-x-5 peer-checked:after:bg-primary-foreground motion-reduce:transition-none motion-reduce:after:transition-none"
      />
    </>
  );
}
