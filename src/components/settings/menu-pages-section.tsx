import { useState } from "react";
import { GroupedList } from "@/components/ui/grouped-list";
import { HIDEABLE_PAGES, setPageHidden, useHiddenPages } from "@/lib/hidden-pages";
import { cn } from "@/lib/utils";

/** Settings › App: switch off pages you don't use, so the sidebar and More only list the rest. */
export function MenuPagesSection() {
  const hidden = useHiddenPages();
  const [failed, setFailed] = useState(false);
  return (
    <section aria-labelledby="menu-pages-heading">
      <h2 id="menu-pages-heading" className="text-lg font-semibold text-foreground">
        Pages in the menu
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        Turn off what you don&apos;t use. Its data stays, and links to it still work. Only on this
        device.
      </p>
      <GroupedList className="max-w-xl">
        {Object.entries(HIDEABLE_PAGES).map(([path, label]) => {
          const on = !hidden.includes(path);
          return (
            <div
              key={path}
              className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5"
            >
              <span id={`menu-page-${path.slice(1)}`} className="text-[0.9375rem] text-foreground">
                {label}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-labelledby={`menu-page-${path.slice(1)}`}
                onClick={() => setFailed(!setPageHidden(path, on))}
                className={cn(
                  "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  on ? "bg-primary" : "bg-muted",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-block size-5 rounded-full bg-background shadow-sm transition-transform",
                    on ? "translate-x-[1.125rem]" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          );
        })}
      </GroupedList>
      {failed && (
        <p role="alert" className="mt-3 text-sm text-negative">
          Couldn&apos;t save on this device: the browser blocks site storage.
        </p>
      )}
    </section>
  );
}
