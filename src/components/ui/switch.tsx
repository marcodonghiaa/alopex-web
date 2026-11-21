import type { InputHTMLAttributes } from "react";

// On/off switch: a native checkbox with role="switch", drawn as the iOS-sized track (51×31) that
// turns positive green when on. Put it inside a <label> or give it aria-label / aria-labelledby.
export function Switch(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">) {
  return (
    <>
      <input type="checkbox" role="switch" {...props} className="peer sr-only" />
      <span
        aria-hidden
        className="relative h-[31px] w-[51px] shrink-0 rounded-full bg-foreground/15 transition-colors peer-checked:bg-positive peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:absolute after:top-[2px] after:left-[2px] after:size-[27px] after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5"
      />
    </>
  );
}
